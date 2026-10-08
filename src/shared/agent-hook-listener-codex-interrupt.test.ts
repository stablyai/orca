import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { reconcileRemoteCodexState } from './agent-hook-listener/providers/codex-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

// Payload shape from codex-rs/hooks/schema/generated/interrupt.command.input.schema.json.
const INTERRUPT = {
  hook_event_name: 'Interrupt',
  session_id: 'session-1',
  turn_id: 'turn-1',
  transcript_path: null,
  cwd: '/repo',
  model: 'gpt-5.5',
  permission_mode: 'default'
}

describe("Codex's Interrupt hook", () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function post(payload: Record<string, unknown>): ReturnType<typeof normalizeHookPayload> {
    return normalizeHookPayload(state, 'codex', { paneKey: PANE_KEY, payload }, 'production')
  }

  function startTurn(): void {
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'list files' })
  }

  it('ends a turn blocked on an approval the user declined with Esc', () => {
    startTurn()
    expect(post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })?.payload.state).toBe(
      'waiting'
    )

    const interrupted = post(INTERRUPT)?.payload
    expect(interrupted).toMatchObject({
      state: 'done',
      interrupted: true,
      prompt: 'list files',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('ends a turn the user cancelled mid-tool', () => {
    startTurn()
    expect(post({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })?.payload.state).toBe(
      'working'
    )

    expect(post(INTERRUPT)?.payload).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('keeps live child work in the row while the main agent reads cancelled', () => {
    startTurn()
    post({ hook_event_name: 'SubagentStart', agent_id: 'child', agent_type: 'worker' })

    const interrupted = post(INTERRUPT)?.payload
    expect(interrupted?.state).toBe('working')
    expect(interrupted?.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
    expect(interrupted?.subagents?.map((subagent) => subagent.id)).toEqual(['child'])

    // A late child event must not resurrect the cancelled main turn.
    const childEvent = post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      agent_id: 'child',
      agent_type: 'worker'
    })?.payload
    expect(childEvent?.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })

    const childDone = post({ hook_event_name: 'SubagentStop', agent_id: 'child' })?.payload
    expect(childDone).toMatchObject({ state: 'done', interrupted: true })
  })

  it('clears the cancellation when the next turn starts', () => {
    startTurn()
    post(INTERRUPT)
    startTurn()
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)).toMatchObject({ state: 'working' })
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)?.outcome).toBeUndefined()
  })

  it('records the cancellation when a relay forwards the Interrupt row', () => {
    reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'PermissionRequest',
      undefined,
      { state: 'waiting', prompt: 'ship', agentType: 'codex' },
      undefined
    )
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Interrupt',
      undefined,
      { state: 'done', prompt: 'ship', agentType: 'codex', interrupted: true },
      undefined
    )
    expect(reconciled).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})

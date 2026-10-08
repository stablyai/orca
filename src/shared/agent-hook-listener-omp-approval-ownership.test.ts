import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'

/**
 * omp is the inverse of Codex: it emits `tool_approval_requested` only after its own policy engine
 * resolved to "prompt", and then parks on a human Approve/Deny select. Auto-approved calls emit
 * nothing at all, so the event always means a human is blocked.
 *
 * The emitter forwards omp's `approval_mode`, which is the ambient mode (`always-ask` | `write` |
 * `yolo`) rather than the verdict. A per-tool `tools.approval.<tool>: prompt` prompts under every
 * mode, so a genuinely blocked human arrives carrying `yolo`. These pin that no value of that
 * field — recognised or not — can downgrade the wait to working (STA-7698).
 */
describe('OMP approval ownership', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function post(
    agentType: 'omp' | 'pi',
    payload: Record<string, unknown>
  ): ReturnType<typeof normalizeHookPayload> {
    return normalizeHookPayload(state, agentType, { paneKey: PANE_KEY, payload }, 'production')
  }

  function approvalRequest(
    extra: Record<string, unknown>
  ): ReturnType<typeof normalizeHookPayload> {
    return post('omp', {
      hook_event_name: 'tool_approval_requested',
      tool_name: 'bash',
      ...extra
    })
  }

  // omp 17.0.5's `tools.approvalMode` enum, captured off the wire from a real run of each mode.
  it.each(['always-ask', 'write', 'yolo'])(
    'keeps an approval request blocked under approval_mode %s',
    (approvalMode) => {
      expect(approvalRequest({ approval_mode: approvalMode })?.payload).toMatchObject({
        state: 'blocked',
        agentType: 'omp',
        toolName: 'bash'
      })
    }
  )

  // `yolo` is the omp default and the one value that looks auto-approving, but omp only emits the
  // event when something already forced a prompt, so downgrading on it would hide a live prompt.
  it('keeps a yolo-mode approval request blocked even though yolo auto-approves by default', () => {
    expect(approvalRequest({ approval_mode: 'yolo' })?.payload.state).toBe('blocked')
  })

  it.each([
    ['missing', {}],
    ['unrecognised', { approval_mode: 'some-future-mode' }],
    ['non-string', { approval_mode: 3 }],
    ['null', { approval_mode: null }]
  ])('treats a %s approval_mode exactly like today', (_name, extra) => {
    expect(approvalRequest(extra)?.payload.state).toBe('blocked')
  })

  it('reports the reason omp sends as the tool input preview', () => {
    // omp's bash tool returns this reason for its critical-pattern override.
    expect(
      approvalRequest({ reason: 'Critical pattern detected', approval_mode: 'write' })?.payload
    ).toMatchObject({ state: 'blocked', toolInput: 'Critical pattern detected' })
  })

  it('leaves the tool input unset when omp sends no reason', () => {
    expect(approvalRequest({ approval_mode: 'always-ask' })?.payload.toolInput).toBeUndefined()
  })

  it('clears the wait on resolution regardless of the mode that requested it', () => {
    expect(approvalRequest({ approval_mode: 'yolo' })?.payload.state).toBe('blocked')
    expect(
      post('omp', {
        hook_event_name: 'tool_approval_resolved',
        tool_name: 'bash',
        approved: true
      })?.payload
    ).toMatchObject({ state: 'working', toolName: 'bash' })
  })

  /** Normalizes the post and admits its row, as the hook server does, so the next post sees it. */
  function deliver(payload: Record<string, unknown>): string {
    const event = post('omp', payload)
    if (event) {
      seedLegacyAgentStatusForTests(state, event)
    }
    return state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state ?? 'none'
  }

  // The order omp 17 posted for a denied bash call, captured off a live run's extension events.
  it('keeps the approval wait through the tool_execution_start omp posts right after it', () => {
    expect(deliver({ hook_event_name: 'tool_call', tool_name: 'bash' })).toBe('working')
    expect(
      deliver({
        hook_event_name: 'tool_approval_requested',
        tool_name: 'bash',
        approval_mode: 'always-ask'
      })
    ).toBe('blocked')
    expect(deliver({ hook_event_name: 'tool_execution_start', tool_name: 'bash' })).toBe('blocked')
    expect(
      deliver({ hook_event_name: 'tool_approval_resolved', tool_name: 'bash', approved: false })
    ).toBe('working')
    expect(deliver({ hook_event_name: 'tool_execution_end', tool_name: 'bash' })).toBe('working')
    expect(deliver({ hook_event_name: 'agent_end' })).toBe('done')
  })

  it('ends a held approval wait when a new turn starts', () => {
    deliver({ hook_event_name: 'tool_approval_requested', tool_name: 'bash' })
    expect(deliver({ hook_event_name: 'agent_start' })).toBe('working')
  })

  it('lets an ask wait end on its own tool_execution_end', () => {
    expect(deliver({ hook_event_name: 'tool_execution_start', tool_name: 'ask' })).toBe('blocked')
    expect(deliver({ hook_event_name: 'tool_execution_end', tool_name: 'ask' })).toBe('working')
  })

  // Pi and prime-agent share this normalizer but have no approval lifecycle, so the field must not
  // give their panes a status row.
  it.each(['always-ask', 'write', 'yolo'])(
    'still ignores a Pi approval request carrying approval_mode %s',
    (approvalMode) => {
      expect(
        post('pi', {
          hook_event_name: 'tool_approval_requested',
          tool_name: 'bash',
          approval_mode: approvalMode
        })
      ).toBeNull()
    }
  )

  it('leaves a Pi input modal waiting, not blocked, when approval_mode is present', () => {
    expect(
      post('pi', {
        hook_event_name: 'ui_prompt_start',
        approval_mode: 'yolo'
      })?.payload.state
    ).toBe('waiting')
  })
})

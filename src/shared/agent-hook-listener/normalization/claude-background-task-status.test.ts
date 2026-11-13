import { describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  movePaneCacheState,
  type HookListenerState
} from '../listener-state'
import { seedClaudeSubagentRosterFromSnapshots } from '../providers/claude/lifecycle/claude-roster-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

const SOURCE_PANE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET_PANE = makePaneKey('tab-target', '22222222-2222-4222-8222-222222222222')
const RUNNING_SHELL = {
  id: 'b8rs2wmxg',
  type: 'shell',
  status: 'running',
  description: 'Sleep for 15 seconds',
  command: 'sleep 15'
}

function claudeEvent(state: HookListenerState, paneKey: string, payload: Record<string, unknown>) {
  return normalizeHookPayload(state, 'claude', { paneKey, payload }, 'production')?.payload
}

describe('Claude background task status', () => {
  // SDK local_* names share inventory classification; teammate tasks stay running permanently, so lifecycle events own their pane state (#8825).

  // Completion notifications need turnCompletedAt while the pane remains working for monitoring; pin both predicates (STA-4119).

  it('holds the finish of a lead that ends into a working subagent, unless the lead failed', () => {
    const state = createHookListenerState()

    claudeEvent(state, SOURCE_PANE, { hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
    claudeEvent(state, SOURCE_PANE, { hook_event_name: 'SubagentStart', agent_id: 'child-1' })
    const childWorking = claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'child-1', type: 'subagent', status: 'running' }]
    })
    expect(childWorking).toMatchObject({ state: 'working', workingMode: undefined })
    expect(childWorking?.turnCompletedAt).toBeUndefined()

    claudeEvent(state, SOURCE_PANE, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    const failed = claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'StopFailure',
      background_tasks: [{ id: 'child-1', type: 'subagent', status: 'running' }]
    })
    expect(failed).toMatchObject({ state: 'working', workingMode: undefined })
    expect(typeof failed?.turnCompletedAt).toBe('number')
  })

  it('holds a coordinator waiting on workers in the background, even across a listener restart', () => {
    const wait = {
      id: 'wait-1',
      type: 'shell',
      status: 'running',
      description: 'Wait for next worker message',
      command:
        '/usr/local/bin/orca orchestration check --wait --types worker_done --json 2>/dev/null'
    }
    const launched = createHookListenerState()
    claudeEvent(launched, SOURCE_PANE, { hook_event_name: 'UserPromptSubmit', prompt: 'run' })
    claudeEvent(launched, SOURCE_PANE, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: wait.command, run_in_background: true },
      tool_response: { backgroundTaskId: 'wait-1' }
    })
    // Only the dev server is still listed; the ended wait's notification is still owed.
    const owed = claudeEvent(launched, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })
    expect(owed).toMatchObject({ state: 'working', workingMode: undefined })
    expect(owed?.turnCompletedAt).toBeUndefined()

    const restarted = createHookListenerState()
    claudeEvent(restarted, SOURCE_PANE, { hook_event_name: 'UserPromptSubmit', prompt: 'run' })
    const listed = claudeEvent(restarted, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [wait]
    })
    expect(listed).toMatchObject({ state: 'working', workingMode: undefined })
    expect(listed?.turnCompletedAt).toBeUndefined()
    // Only listed, it may be a subagent's wait, whose result never reaches this agent.
    expect(
      claudeEvent(restarted, SOURCE_PANE, { hook_event_name: 'Stop', background_tasks: [] })?.state
    ).toBe('done')
  })

  it('does not stamp a wake-up turn that ends with only a monitor that will wake it again', () => {
    const state = createHookListenerState()

    claudeEvent(state, SOURCE_PANE, { hook_event_name: 'UserPromptSubmit', prompt: 'watch' })
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 15', run_in_background: true },
      tool_response: { backgroundTaskId: RUNNING_SHELL.id }
    })
    claudeEvent(state, SOURCE_PANE, { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'UserPromptSubmit',
      prompt: `<task-notification>\n<task-id>${RUNNING_SHELL.id}</task-id>\n<event>tick</event>`
    })
    const wakeEnd = claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })

    expect(wakeEnd).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(wakeEnd?.turnCompletedAt).toBeUndefined()
  })

  it('keeps pending task state when pane authority moves', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })

    movePaneCacheState(state, SOURCE_PANE, TARGET_PANE)

    expect(
      claudeEvent(state, TARGET_PANE, {
        hook_event_name: 'SubagentStop',
        agent_id: 'a70fdf2986e38302b'
      })?.state
    ).toBe('working')
  })

  it('keeps a shell the interrupted Stop still lists until an inventory omits it', () => {
    const state = createHookListenerState()
    const monitoring = {
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    }
    const interrupted = claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      is_interrupt: true,
      background_tasks: [RUNNING_SHELL]
    })

    expect(interrupted).toMatchObject(monitoring)
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStop',
        agent_id: 'a70fdf2986e38302b',
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject(monitoring)
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject(monitoring)
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStop',
        agent_id: 'a8ab60ba5d4410c47',
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject(monitoring)
    // Inventory omission settles the shell; interrupted restates the carried lead verdict for old readers.
    expect(
      claudeEvent(state, SOURCE_PANE, { hook_event_name: 'Stop', background_tasks: [] })
    ).toMatchObject({ state: 'done', interrupted: true, mainAgent: { outcome: 'cancellation' } })
  })

  it('drops interrupted state on a mid-turn lead event with no prompt submit', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, { hook_event_name: 'Stop', is_interrupt: true })

    // Why: a resumed turn can start at a tool event; the next Stop must not inherit the old interrupt and discard live work.
    expect(claudeEvent(state, SOURCE_PANE, { hook_event_name: 'PreToolUse' })?.state).toBe(
      'working'
    )
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'working', interrupted: undefined })
  })

  it('retains live child rows when an agent inventory is partial or has a future status', () => {
    for (const backgroundTask of [
      { id: 'child-1', type: 'subagent', status: 'in_progress' },
      { id: 'child-1', type: 'subagent' },
      { task_id: 'child-1', type: 'subagent', status: 'running' }
    ]) {
      const state = createHookListenerState()
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStart',
        agent_id: 'child-1'
      })

      expect(
        claudeEvent(state, SOURCE_PANE, {
          hook_event_name: 'Stop',
          background_tasks: [backgroundTask]
        })
      ).toMatchObject({
        state: 'working',
        subagents: [expect.objectContaining({ id: 'child-1', state: 'working' })]
      })
    }
  })

  it('does not mint working from an unconfirmed child-attributed Stop', () => {
    const state = createHookListenerState()
    seedClaudeSubagentRosterFromSnapshots(state, SOURCE_PANE, [
      { id: 'restored-child', state: 'working', startedAt: 100 }
    ])

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        agent_id: 'unknown-child',
        background_tasks: []
      })
    ).toBeUndefined()
  })

  it('shows a child permission wait after the lead turn is interrupted', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'SubagentStart',
      agent_id: 'child-1'
    })
    claudeEvent(state, SOURCE_PANE, { hook_event_name: 'Stop', is_interrupt: true })

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'PermissionRequest',
        agent_id: 'child-1',
        tool_name: 'Bash',
        tool_input: { command: 'git status' }
      })
    ).toMatchObject({ state: 'waiting', toolName: 'Bash' })
  })
})

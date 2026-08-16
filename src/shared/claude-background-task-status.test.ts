import { describe, expect, it } from 'vitest'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  markClaudeLeadTurnInterrupted,
  movePaneCacheState,
  normalizeHookPayload,
  seedClaudeSubagentRosterFromSnapshots,
  type HookListenerState
} from './agent-hook-listener'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import { readClaudeBackgroundAgentTasks } from './claude-background-task-inventory'
import { makePaneKey } from './stable-pane-id'

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
  it('finds pending monitor work after the visible child-row cap', () => {
    const agentTasks = Array.from({ length: AGENT_STATUS_MAX_SUBAGENTS + 1 }, (_, index) => ({
      id: `agent-${index}`,
      type: 'subagent',
      status: 'running'
    }))
    const result = readClaudeBackgroundAgentTasks({
      background_tasks: [...agentTasks, { id: 'monitor-1', type: 'monitor', status: 'pending' }]
    })

    expect(result).toMatchObject({ truncated: true, hasRunningNonAgentTask: true })
    expect(result.tasks).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)

    const state = createHookListenerState()
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        background_tasks: [...agentTasks, { id: 'monitor-1', type: 'monitor', status: 'pending' }]
      })?.state
    ).toBe('working')
  })

  it('fails unknown, partial, or malformed task entries active but ignores terminal entries', () => {
    for (const status of ['queued', undefined]) {
      expect(
        readClaudeBackgroundAgentTasks({
          background_tasks: [{ id: 'shell-1', type: 'shell', status }]
        }).hasRunningNonAgentTask
      ).toBe(true)
    }
    expect(
      readClaudeBackgroundAgentTasks({
        background_tasks: [{ id: 'task-1', type: 'background_shell', status: 'starting' }]
      }).hasRunningNonAgentTask
    ).toBe(true)
    for (const task of [
      { id: 'task-1', status: 'running' },
      { id: 'task-1', type: 42, status: 'running' },
      { id: 'task-1', type: ' ', status: 'running' }
    ]) {
      expect(readClaudeBackgroundAgentTasks({ background_tasks: [task] })).toMatchObject({
        truncated: true,
        hasRunningNonAgentTask: true
      })
    }
    expect(
      readClaudeBackgroundAgentTasks({ background_tasks: [null, 'shell'] }).hasRunningNonAgentTask
    ).toBe(true)

    for (const backgroundTasks of [
      [{ id: 'shell-1', type: 'shell', status: 'completed' }],
      [{ id: 'shell-1', type: 'shell', status: ' Completed ' }],
      ...[
        'done',
        'success',
        'succeeded',
        'complete',
        'finished',
        'error',
        'terminated',
        'exited',
        'aborted',
        'expired',
        'skipped',
        'crashed'
      ].map((status) => [{ id: 'shell-1', type: 'shell', status }]),
      [{ id: 'shell-1', type: 'shell', status: 'canceled' }],
      [{ id: 'shell-1', type: 'shell', status: 'timed_out' }],
      [{ id: 'agent-1', type: ' Subagent ', status: 'running' }],
      { id: 'shell-1', type: 'shell', status: 'running' }
    ]) {
      expect(
        readClaudeBackgroundAgentTasks({ background_tasks: backgroundTasks }).hasRunningNonAgentTask
      ).toBe(false)
    }
  })

  it('stays working through Claude 2.1.220 Stop and SubagentStop until the shell finishes', () => {
    const state = createHookListenerState()

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'run a background sleep'
      })?.state
    ).toBe('working')
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        background_tasks: [RUNNING_SHELL]
      })?.state
    ).toBe('working')
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStop',
        agent_id: 'a70fdf2986e38302b',
        background_tasks: [RUNNING_SHELL]
      })?.state
    ).toBe('working')

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification><status>completed</status></task-notification>'
      })?.state
    ).toBe('working')
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        background_tasks: []
      })?.state
    ).toBe('done')
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

  it('keeps an interrupted Stop terminal even when its task inventory is still running', () => {
    const state = createHookListenerState()
    const interrupted = claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      is_interrupt: true,
      background_tasks: [RUNNING_SHELL]
    })

    expect(interrupted).toMatchObject({ state: 'done', interrupted: true })
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStop',
        agent_id: 'a70fdf2986e38302b',
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'done', interrupted: true })
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'done', interrupted: true })
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStop',
        agent_id: 'a8ab60ba5d4410c47',
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'done', interrupted: true })
  })

  it('keeps an interrupted Stop terminal while a session cron remains', () => {
    const state = createHookListenerState()

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        is_interrupt: true,
        session_crons: [{ id: 'cron-1' }]
      })
    ).toMatchObject({ state: 'done', interrupted: true })
  })

  it('keeps a session cron working through child lifecycle events until a drained inventory', () => {
    const state = createHookListenerState()

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        session_crons: [{ id: 'cron-1' }]
      })?.state
    ).toBe('working')
    expect(state.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(true)
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStop',
        agent_id: 'child-1'
      })?.state
    ).toBe('working')
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        background_tasks: []
      })?.state
    ).toBe('done')
    expect(state.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(false)
  })

  it('drains a reported cron inventory mid-turn, not only at a turn boundary', () => {
    const state = createHookListenerState()

    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      session_crons: [{ id: 'cron-1' }]
    })
    expect(state.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(true)

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'PostToolUse',
        session_crons: []
      })?.state
    ).toBe('working')
    expect(state.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(false)

    // Why: the mid-turn drain must survive to the next boundary — a Stop that reports
    // nothing is the case where a stale cron flag would pin the pane 'working'.
    expect(claudeEvent(state, SOURCE_PANE, { hook_event_name: 'Stop' })?.state).toBe('done')
  })

  it('only infers an omitted cron inventory is drained from modern lead Stop payloads', () => {
    const createCronState = (): HookListenerState => {
      const state = createHookListenerState()
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        session_crons: [{ id: 'cron-1' }]
      })
      return state
    }

    const midTurnState = createCronState()
    claudeEvent(midTurnState, SOURCE_PANE, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue',
      background_tasks: []
    })
    expect(midTurnState.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(true)

    const legacyStopState = createCronState()
    expect(claudeEvent(legacyStopState, SOURCE_PANE, { hook_event_name: 'Stop' })?.state).toBe(
      'working'
    )
    expect(legacyStopState.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(true)
  })

  it('treats an interrupted StopFailure as terminal', () => {
    const state = createHookListenerState()

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'StopFailure',
        is_interrupt: true,
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'done', interrupted: true })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(SOURCE_PANE)).toBe(false)
  })

  it('keeps a failed turn working while its background shell runs', () => {
    const state = createHookListenerState()

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'StopFailure',
        background_tasks: [RUNNING_SHELL]
      })?.state
    ).toBe('working')
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'StopFailure',
        background_tasks: []
      })?.state
    ).toBe('done')
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

  it('resumes on task notifications and user slash commands after interruption', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      is_interrupt: true,
      background_tasks: [RUNNING_SHELL]
    })

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification><status>completed</status></task-notification>',
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'working' })
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        is_interrupt: true,
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'done', interrupted: true })
    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'UserPromptSubmit',
        prompt: '<command-message>review</command-message><command-name>/review</command-name>',
        background_tasks: [RUNNING_SHELL]
      })?.state
    ).toBe('working')
  })

  it('ignores child-attributed inventories for lead-owned background work', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      agent_id: 'child-1',
      background_tasks: [RUNNING_SHELL],
      session_crons: [{ id: 'cron-1' }]
    })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(SOURCE_PANE)).toBe(false)
    expect(state.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(false)

    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL],
      session_crons: [{ id: 'cron-1' }]
    })
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      agent_id: 'child-1',
      background_tasks: [],
      session_crons: []
    })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(SOURCE_PANE)).toBe(true)
    expect(state.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(true)

    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [],
      session_crons: []
    })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(SOURCE_PANE)).toBe(false)
    expect(state.claudeActiveSessionCronPaneKeys.has(SOURCE_PANE)).toBe(false)
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

  it('retains live child rows when inventory entries cannot be classified', () => {
    for (const backgroundTasks of [[{ id: 'child-1', status: 'running' }], [null, 'shell', 42]]) {
      const state = createHookListenerState()
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStart',
        agent_id: 'child-1'
      })

      expect(
        claudeEvent(state, SOURCE_PANE, {
          hook_event_name: 'Stop',
          background_tasks: backgroundTasks
        })
      ).toMatchObject({
        state: 'working',
        subagents: [expect.objectContaining({ id: 'child-1', state: 'working' })]
      })
    }
  })

  it('does not fold a Stop inventory attributed to an unknown child', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'SubagentStart',
      agent_id: 'child-1'
    })

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        agent_id: 'unknown-child',
        background_tasks: []
      })
    ).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: 'child-1', state: 'working' })]
    })
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

  it('does not let an unknown child interrupt lead-owned background work', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue lead work'
    })

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'Stop',
        agent_id: 'unknown-child',
        is_interrupt: true
      })
    ).toMatchObject({ state: 'working' })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(SOURCE_PANE)).toBe(true)
  })

  it('keeps background gating through an empty child SubagentStop inventory', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'SubagentStop',
        agent_id: 'child-1',
        background_tasks: []
      })?.state
    ).toBe('working')
  })

  it('ignores TeammateIdle inventories for lead-owned background work', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })

    expect(
      claudeEvent(state, SOURCE_PANE, {
        hook_event_name: 'TeammateIdle',
        teammate_name: 'reviewer',
        background_tasks: []
      })?.state
    ).toBe('working')
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(SOURCE_PANE)).toBe(true)

    claudeEvent(state, SOURCE_PANE, { hook_event_name: 'Stop', background_tasks: [] })
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'TeammateIdle',
      teammate_name: 'reviewer',
      background_tasks: [RUNNING_SHELL]
    })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(SOURCE_PANE)).toBe(false)
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

  it('preserves authoritative work across partial inventories and clears it on teardown', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })

    expect(claudeEvent(state, SOURCE_PANE, { hook_event_name: 'Stop' })?.state).toBe('working')
    clearPaneCacheState(state, SOURCE_PANE)
    expect(state.claudeRunningNonAgentTaskPaneKeys.size).toBe(0)

    claudeEvent(state, TARGET_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })
    clearAllListenerCaches(state)
    expect(state.claudeRunningNonAgentTaskPaneKeys.size).toBe(0)
  })

  it('clears background gating when the server infers an interruption', () => {
    const state = createHookListenerState()
    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'Stop',
      background_tasks: [RUNNING_SHELL]
    })

    markClaudeLeadTurnInterrupted(state, SOURCE_PANE)
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(SOURCE_PANE)).toBe(false)
  })
})

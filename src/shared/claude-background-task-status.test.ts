import { describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  movePaneCacheState,
  normalizeHookPayload,
  type HookListenerState
} from './agent-hook-listener'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import { readClaudeBackgroundAgentTasks } from './claude-subagent-roster'
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

    expect(result).toMatchObject({ truncated: true, hasRunningShellOrMonitor: true })
    expect(result.tasks).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)
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

    claudeEvent(state, SOURCE_PANE, {
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification><status>completed</status></task-notification>'
    })
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
  })
})

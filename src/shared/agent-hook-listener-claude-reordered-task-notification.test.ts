import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SESSION = '00000000-0000-4000-8000-000000000000'
const notification = {
  hook_event_name: 'UserPromptSubmit',
  prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
}
const launch = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Agent',
  tool_response: { isAsync: true, agentId: 'a1' }
}

function listener() {
  const state = createHookListenerState()
  const post = (payload: Record<string, unknown>) =>
    normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { session_id: SESSION, ...payload } },
      'production'
    )
  post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
  return { state, post }
}

describe('out-of-order Claude child notifications', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['unknown', 'restored', 'wrong-session', 'unanchored'])(
    'does not turn %s child-end evidence into a main notification obligation',
    (evidence) => {
      const { state, post } = listener()
      if (evidence !== 'unknown') {
        post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
      }
      if (evidence === 'restored') {
        const child = state.claudeSubagentRosterByPaneKey.get(PANE_KEY)?.get('a1')
        if (child) {
          child.restoredFromSnapshot = true
        }
      } else if (evidence === 'unanchored') {
        state.claudeSessionOwnerByPaneKey.delete(PANE_KEY)
      }
      post({
        hook_event_name: 'SubagentStop',
        agent_id: 'a1',
        ...(evidence === 'wrong-session' ? { session_id: 'old-session' } : {})
      })
      expect(state.claudeLaunchedBackgroundTasksByPaneKey.get(PANE_KEY)?.has('a1')).not.toBe(true)
      post(launch)
      expect(
        post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.claudeTaskWakeupPending
      ).toBeUndefined()
    }
  )

  it.each(['unknown', 'restored'])(
    'does not use an %s child as an early notification receipt',
    (evidence) => {
      const { state, post } = listener()
      if (evidence === 'restored') {
        state.claudeSubagentRosterByPaneKey.set(
          PANE_KEY,
          new Map([['a1', { state: 'working', startedAt: Date.now(), restoredFromSnapshot: true }]])
        )
      }
      post(notification)
      expect(state.claudeLaunchedBackgroundTasksByPaneKey.get(PANE_KEY)?.has('a1')).not.toBe(true)
    }
  )

  it('keeps an unmatched nested child end provisional until its own main launch confirms it', () => {
    const { state, post } = listener()
    post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    expect(
      state.claudeLaunchedBackgroundTasksByPaneKey.get(PANE_KEY)?.get('a1')?.launchUnconfirmed
    ).toBe(true)
    expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('done')
    post(launch)
    expect(
      post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.claudeTaskWakeupPending
    ).toBe('notification')
  })

  it('does not refresh the observed end on duplicate end or parent launch posts', () => {
    const { state, post } = listener()
    post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    const firstEnd = state.claudeLaunchedBackgroundTasksByPaneKey
      .get(PANE_KEY)
      ?.get('a1')?.notificationOwedAt
    vi.advanceTimersByTime(5_000)
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    post(launch)
    post(launch)
    expect(
      state.claudeLaunchedBackgroundTasksByPaneKey.get(PANE_KEY)?.get('a1')?.notificationOwedAt
    ).toBe(firstEnd)
  })

  it.each(['before-end', 'after-end', 'after-launch'])(
    'preserves a delivered notification %s through late end/launch, and rearms a real same-id start',
    (order) => {
      const { post } = listener()
      post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
      if (order === 'after-launch') {
        post(launch)
      }
      if (order === 'before-end') {
        post(notification)
      }
      post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      if (order !== 'before-end') {
        post(notification)
      }
      post(launch)
      post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('done')
      post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
      post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      post(launch)
      expect(
        post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.claudeTaskWakeupPending
      ).toBe('notification')
    }
  )
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, clearPaneCacheState } from './agent-hook-listener/listener-state'
import { ClaudeOwedNotificationExpiryTimers } from './claude-owed-notification-expiry-timers'
import {
  CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS,
  oweClaudeAgentTaskNotification,
  recordClaudeBackgroundTaskLaunch,
  recordClaudeUnconfirmedAgentEnd,
  claudeOwedTaskNotificationDeadline,
  claudeLiveOwedTaskNotificationKinds,
  type ClaudeLaunchedBackgroundTasks
} from './claude-owed-task-notifications'

describe('Claude notification resource bounds', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('caps live task records without evicting a tracked running task', () => {
    const tasks: ClaudeLaunchedBackgroundTasks = new Map()
    for (let index = 0; index < 4096; index += 1) {
      recordClaudeBackgroundTaskLaunch(tasks, { id: `agent-${index}`, kind: 'agent' })
    }
    expect(tasks.size).toBe(256)
    expect(tasks.has('agent-0')).toBe(true)
    oweClaudeAgentTaskNotification(tasks, 'agent-0', Date.now())
    expect(tasks.get('agent-0')?.notificationOwedAt).toBe(Date.now())
  })

  it('evicts unmatched child ends before confirmed work and activates only a confirmed parent launch', () => {
    const tasks: ClaudeLaunchedBackgroundTasks = new Map()
    recordClaudeBackgroundTaskLaunch(tasks, { id: 'main-task', kind: 'agent' })
    oweClaudeAgentTaskNotification(tasks, 'main-task', Date.now())
    for (let index = 0; index < 4096; index += 1) {
      recordClaudeUnconfirmedAgentEnd(tasks, `nested-${index}`, Date.now())
    }
    expect(tasks.size).toBe(256)
    expect(tasks.get('main-task')?.notificationOwedAt).toBe(Date.now())
    recordClaudeBackgroundTaskLaunch(tasks, { id: 'later-main-task', kind: 'agent' })
    expect(tasks.has('later-main-task')).toBe(true)
    expect(tasks.has('main-task')).toBe(true)
    const provisional: ClaudeLaunchedBackgroundTasks = new Map()
    recordClaudeUnconfirmedAgentEnd(provisional, 'late-launch', Date.now())
    expect(claudeLiveOwedTaskNotificationKinds(provisional, true, Date.now())).toEqual({
      agent: false,
      shell: false
    })
    expect(claudeOwedTaskNotificationDeadline(provisional, Date.now())).toBeUndefined()
    vi.advanceTimersByTime(100)
    recordClaudeBackgroundTaskLaunch(provisional, { id: 'late-launch', kind: 'agent' })
    expect(claudeLiveOwedTaskNotificationKinds(provisional, true, Date.now()).agent).toBe(true)
  })

  it('shares one timer across 512 panes and publishes nothing for closed owners', () => {
    const state = createHookListenerState()
    const timers = new ClaudeOwedNotificationExpiryTimers(state)
    const publish = vi.fn()
    for (let index = 0; index < 512; index += 1) {
      const paneKey = `pane-${index}`
      const tasks: ClaudeLaunchedBackgroundTasks = new Map()
      recordClaudeBackgroundTaskLaunch(tasks, { id: 'agent', kind: 'agent' })
      oweClaudeAgentTaskNotification(tasks, 'agent', Date.now())
      state.claudeLaunchedBackgroundTasksByPaneKey.set(paneKey, tasks)
      state.claudeLeadStateByPaneKey.set(paneKey, { state: 'done', stateStartedAt: Date.now() })
      timers.arm(paneKey, publish)
    }
    expect(vi.getTimerCount()).toBe(1)
    for (const paneKey of state.claudeLaunchedBackgroundTasksByPaneKey.keys()) {
      clearPaneCacheState(state, paneKey)
    }
    vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)
    expect(publish).not.toHaveBeenCalled()
    expect(state.claudeLaunchedBackgroundTasksByPaneKey.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    timers.clearAll()
  })

  it('clears the shared deadline timer when its host stops', () => {
    const state = createHookListenerState()
    const tasks: ClaudeLaunchedBackgroundTasks = new Map()
    recordClaudeBackgroundTaskLaunch(tasks, { id: 'agent', kind: 'agent' })
    oweClaudeAgentTaskNotification(tasks, 'agent', Date.now())
    state.claudeLaunchedBackgroundTasksByPaneKey.set('pane', tasks)
    state.claudeLeadStateByPaneKey.set('pane', { state: 'done', stateStartedAt: Date.now() })
    const timers = new ClaudeOwedNotificationExpiryTimers(state)
    const publish = vi.fn()
    timers.arm('pane', publish)
    expect(vi.getTimerCount()).toBe(1)
    timers.clearAll()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)
    expect(publish).not.toHaveBeenCalled()
  })
})

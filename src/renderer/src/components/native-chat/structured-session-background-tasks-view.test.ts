import { describe, expect, it } from 'vitest'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'

function view(membership: 'live' | 'settled', kind: AgentChildWorkView['kind'] = 'agent') {
  return {
    id: `${kind}-${membership}`,
    kind,
    state: membership === 'live' ? 'working' : 'done',
    membership,
    ...(membership === 'settled' ? { outcome: 'succeeded', settledAt: 2 } : {}),
    firstObservedAt: 1,
    observedAt: 2,
    stoppable: false,
    invocation: { invocationId: 'run-1', generation: 1 }
  } satisfies AgentChildWorkView
}

describe('structuredSessionBackgroundTasksView', () => {
  it('shows finished children until the next turn, but they hold nothing open', () => {
    const finished = structuredSessionBackgroundTasksView(
      { state: 'monitoring', children: [view('settled')] },
      null
    )
    expect(finished).toMatchObject({ show: true, isMonitoring: false, children: [view('settled')] })
  })

  it('reads live work beneath an idle session as monitoring, and a running turn as its own', () => {
    const roster = {
      state: 'monitoring' as const,
      children: [view('settled'), view('live', 'command')]
    }
    expect(structuredSessionBackgroundTasksView(roster, null).isMonitoring).toBe(true)
    expect(structuredSessionBackgroundTasksView(roster, 'turn-1').isMonitoring).toBe(false)
  })

  it('reads an older host that publishes no views exactly as before', () => {
    const tasks = [{ id: 'task-1', kind: 'agent' as const }]
    expect(structuredSessionBackgroundTasksView({ state: 'monitoring', tasks }, null)).toEqual({
      show: true,
      isMonitoring: true,
      tasks,
      settledTasks: [],
      supportsStop: false,
      supportsStopAll: true
    })
    expect(structuredSessionBackgroundTasksView(null, null)).toMatchObject({
      show: false,
      isMonitoring: false
    })
  })
})

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

  it('hands the strip the decoded roster it was given, so its grouped rows stay memoized', () => {
    const roster = { state: 'monitoring' as const, children: [view('live')] }
    expect(structuredSessionBackgroundTasksView(roster, null).children).toBe(roster.children)
    expect(structuredSessionBackgroundTasksView(roster, 'turn-1').children).toBe(roster.children)
  })

  it('keeps the same empty lists for a roster that omits one, so the strip memo holds', () => {
    for (const roster of [
      { state: 'monitoring' as const, tasks: [{ id: 'task-1', kind: 'agent' as const }] },
      { state: 'monitoring' as const, settledTasks: [{ id: 'task-2', kind: 'agent' as const }] },
      null
    ]) {
      const first = structuredSessionBackgroundTasksView(roster, null)
      const again = structuredSessionBackgroundTasksView(roster, null)
      expect(again.tasks).toBe(first.tasks)
      expect(again.settledTasks).toBe(first.settledTasks)
    }
  })

  it('reads live work beneath an idle session as monitoring, and a running turn as its own', () => {
    const roster = {
      state: 'monitoring' as const,
      children: [view('settled'), view('live', 'command')]
    }
    expect(structuredSessionBackgroundTasksView(roster, null).isMonitoring).toBe(true)
    expect(structuredSessionBackgroundTasksView(roster, 'turn-1').isMonitoring).toBe(false)
  })

  it("shows an older host's running tasks only, and nothing once only finished ones are left", () => {
    const tasks = [{ id: 'task-1', kind: 'agent' as const }]
    const settledTasks = [{ id: 'task-2', kind: 'agent' as const }]
    expect(
      structuredSessionBackgroundTasksView({ state: 'monitoring', tasks, settledTasks }, null)
    ).toMatchObject({ show: true, isMonitoring: true, tasks, settledTasks: [] })
    expect(
      structuredSessionBackgroundTasksView({ state: 'monitoring', settledTasks }, null)
    ).toMatchObject({ show: false, isMonitoring: false })
    // A host that reports state only still says something runs.
    expect(structuredSessionBackgroundTasksView({ state: 'monitoring' }, null).show).toBe(true)
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

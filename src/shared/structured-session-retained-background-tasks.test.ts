import { describe, expect, it } from 'vitest'

import type { AgentChildWorkView } from './agent-status/child-work/agent-status-child-work-view'
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

describe('retained background tasks', () => {
  it.each(['done', 'idle', 'blocked', 'unverifiable'] as const)(
    'retains settled agents with display state %s without treating them as live work',
    (state) => {
      const child = { ...view('settled'), state }
      const finished = structuredSessionBackgroundTasksView(
        { state: 'monitoring', children: [child] },
        null
      )
      expect(finished).toMatchObject({
        show: true,
        isMonitoring: false,
        offersStopAll: false,
        children: [child]
      })
    }
  )

  it('keeps lost contact with a still-live child active', () => {
    const child = { ...view('live'), state: 'unverifiable' as const }
    expect(
      structuredSessionBackgroundTasksView({ state: 'monitoring', children: [child] }, null)
    ).toMatchObject({ show: true, isMonitoring: true, offersStopAll: true })
  })

  it("retains an older host's finished agents without claiming that they still run", () => {
    const tasks = [{ id: 'task-1', kind: 'agent' as const }]
    const settledTasks = [{ id: 'task-2', kind: 'agent' as const }]
    expect(
      structuredSessionBackgroundTasksView({ state: 'monitoring', tasks, settledTasks }, null)
    ).toMatchObject({ show: true, isMonitoring: true, tasks, settledTasks })
    expect(
      structuredSessionBackgroundTasksView({ state: 'monitoring', settledTasks }, null)
    ).toMatchObject({ show: true, isMonitoring: false, offersStopAll: false, settledTasks })
    // A host that reports state only still says something runs.
    expect(structuredSessionBackgroundTasksView({ state: 'monitoring' }, null).show).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentChildWorkView } from './agent-status-child-work-view'
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
  it('does not mount the strip for a foreground command from an older host', () => {
    const id = 'codex-command:primary:pwd'
    const foreground = new Set([id])
    expect(
      structuredSessionBackgroundTasksView(
        { state: 'monitoring', tasks: [{ id, kind: 'command' }] },
        'turn-1',
        foreground
      )
    ).toMatchObject({ show: false, isMonitoring: false, tasks: [] })
  })

  it('removes the foreground command from child views and legacy tasks together', () => {
    const id = 'codex-command:primary:pwd'
    const shell = { ...view('live', 'command'), providerId: id }
    const agent = view('live')
    const tasks = [
      { id, kind: 'command' as const },
      { id: 'child-agent', kind: 'agent' as const }
    ]
    const shown = structuredSessionBackgroundTasksView(
      { state: 'monitoring', tasks, children: [shell, agent] },
      'turn-1',
      new Set([id])
    )
    expect(shown).toMatchObject({ show: true, tasks: [tasks[1]], children: [agent] })
  })

  it('keeps unrelated rosters and commands from earlier turns during the current turn', () => {
    const tasks = [
      { id: 'codex-command:primary:server', kind: 'command' as const },
      { id: 'claude-shell', kind: 'command' as const },
      { id: 'codex-command:thread:child:pwd', kind: 'command' as const }
    ]
    const shown = structuredSessionBackgroundTasksView(
      { state: 'monitoring', tasks },
      'turn-2',
      new Set(['codex-command:primary:pwd'])
    )
    expect(shown.show).toBe(true)
    expect(shown.tasks).toBe(tasks)
  })

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

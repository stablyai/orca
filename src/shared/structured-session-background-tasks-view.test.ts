import { describe, expect, it } from 'vitest'

import type { AgentChildWorkView } from './agent-status-child-work-view'
import {
  structuredSessionBackgroundTasksView,
  structuredSessionConfirmedStopsStillListed,
  structuredSessionListedTaskRun
} from './structured-session-background-tasks-view'

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

  // Unrecorded work keeps the strip visible; commands/rewind still follow listed records as host admission does.
  it('keeps the strip and its Stop when the host could not record some work', () => {
    expect(
      structuredSessionBackgroundTasksView(
        { state: 'monitoring', children: [], supportsTaskStop: true, incomplete: true },
        null
      )
    ).toMatchObject({ show: true, isMonitoring: false, incomplete: true, offersStopAll: true })
  })

  it('reads live work beneath an idle session as monitoring, and a running turn as its own', () => {
    const roster = {
      state: 'monitoring' as const,
      children: [view('settled'), view('live', 'command')]
    }
    expect(structuredSessionBackgroundTasksView(roster, null).isMonitoring).toBe(true)
    expect(structuredSessionBackgroundTasksView(roster, 'turn-1').isMonitoring).toBe(false)
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

describe('a confirmed Stop held per run', () => {
  const helper = (invocationId: string, generation: number): AgentChildWorkView => ({
    ...view('live'),
    providerId: 'thread-helper',
    invocation: { invocationId, generation }
  })
  const withChildren = (children: AgentChildWorkView[]) =>
    structuredSessionBackgroundTasksView({ state: 'monitoring', children }, null)

  it("keys a child's run by its invocation, so the next run under the same id is another", () => {
    const first = withChildren([helper('turn-1', 1)])
    const run = structuredSessionListedTaskRun(first, 'thread-helper')
    expect(run).not.toBeNull()
    const confirmed = new Map([['thread-helper', run!]])

    expect(structuredSessionConfirmedStopsStillListed(first, confirmed)).toBe(confirmed)
    const next = withChildren([helper('turn-2', 2)])
    expect(structuredSessionListedTaskRun(next, 'thread-helper')).not.toBe(run)
    expect(structuredSessionConfirmedStopsStillListed(next, confirmed)).toEqual(new Map())
    expect(structuredSessionConfirmedStopsStillListed(withChildren([]), confirmed)).toEqual(
      new Map()
    )
  })
})

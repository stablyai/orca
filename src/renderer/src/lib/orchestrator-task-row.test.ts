import { describe, expect, it } from 'vitest'
import type { OrchestrationTaskNode } from '../../../shared/runtime-types'
import {
  deriveTaskDotState,
  deriveTaskMessage,
  deriveTaskStatusLabel,
  indexTaskNodes
} from './orchestrator-task-row'

function node(overrides: Partial<OrchestrationTaskNode>): OrchestrationTaskNode {
  return {
    id: 'task_1',
    status: 'ready',
    deps: [],
    title: 'Task 1',
    targetKey: null,
    dispatch: null,
    signal: null,
    ...overrides
  }
}

describe('deriveTaskDotState', () => {
  it('maps each task status to the shared AgentStateDot vocabulary', () => {
    expect(deriveTaskDotState(node({ status: 'pending' }))).toBe('idle')
    expect(deriveTaskDotState(node({ status: 'ready' }))).toBe('idle')
    expect(deriveTaskDotState(node({ status: 'blocked' }))).toBe('blocked')
    expect(deriveTaskDotState(node({ status: 'completed' }))).toBe('done')
    expect(deriveTaskDotState(node({ status: 'failed' }))).toBe('interrupted')
  })

  it('distinguishes a healthy vs stalled dispatched task', () => {
    const working = node({
      status: 'dispatched',
      dispatch: {
        assigneeHandle: 'term_x',
        assigneeAgent: 'codex',
        status: 'dispatched',
        lastHeartbeatAt: '2026-06-01T00:00:00.000Z',
        stale: false
      }
    })
    const stalled = node({
      status: 'dispatched',
      dispatch: { ...working.dispatch!, stale: true }
    })
    expect(deriveTaskDotState(working)).toBe('working')
    expect(deriveTaskDotState(stalled)).toBe('stalled')
  })
})

describe('deriveTaskStatusLabel', () => {
  it('uses short scannable words', () => {
    expect(deriveTaskStatusLabel(node({ status: 'ready' }))).toBe('queued')
    expect(deriveTaskStatusLabel(node({ status: 'completed' }))).toBe('done')
    expect(deriveTaskStatusLabel(node({ status: 'failed' }))).toBe('failed')
  })
})

describe('deriveTaskMessage', () => {
  it('prefers the worker_done summary, then the heartbeat phase (rendered verbatim)', () => {
    const empty = new Map<string, OrchestrationTaskNode>()
    expect(
      deriveTaskMessage(node({ signal: { phase: null, summary: 'Shipped it' } }), empty)
    ).toEqual({ kind: 'signal', text: 'Shipped it' })
    expect(
      deriveTaskMessage(node({ signal: { phase: 'implementing', summary: null } }), empty)
    ).toEqual({ kind: 'signal', text: 'implementing' })
  })

  it('explains a queued task as waiting on its first unmet dependency', () => {
    const dep = node({ id: 'dep_1', title: 'scaffold routes', status: 'dispatched' })
    const waiting = node({ id: 'task_2', status: 'pending', deps: ['dep_1'] })
    const byId = indexTaskNodes({
      runId: 'r',
      recipe: null,
      truncatedTaskCount: 0,
      tasks: [dep, waiting]
    })
    expect(deriveTaskMessage(waiting, byId)).toEqual({ kind: 'waiting', dep: 'scaffold routes' })
  })

  it('does not show a waiting message once the dependency is complete', () => {
    const dep = node({ id: 'dep_1', title: 'scaffold', status: 'completed' })
    const ready = node({ id: 'task_2', status: 'ready', deps: ['dep_1'] })
    const byId = indexTaskNodes({
      runId: 'r',
      recipe: null,
      truncatedTaskCount: 0,
      tasks: [dep, ready]
    })
    expect(deriveTaskMessage(ready, byId)).toBeNull()
  })

  it('omits the waiting hint when the blocking dep is not in the synced set (nit)', () => {
    // A dep truncated past the 200-task cap (or otherwise unknown) must not
    // render a raw uuid as "waiting on <uuid>".
    const waiting = node({ id: 'task_2', status: 'pending', deps: ['dep_truncated'] })
    const byId = indexTaskNodes({
      runId: 'r',
      recipe: null,
      truncatedTaskCount: 1,
      tasks: [waiting]
    })
    expect(deriveTaskMessage(waiting, byId)).toBeNull()
  })
})

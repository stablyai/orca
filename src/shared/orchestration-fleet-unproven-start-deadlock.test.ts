import { describe, expect, it } from 'vitest'
import {
  projectOrchestrationFleet,
  type FleetDurableWorker
} from './orchestration-fleet-projection'
import { WORKER_UNPROVEN_LIFECYCLE_RECONCILE_AFTER_MS } from './orchestration-timing-budgets'

const NOW = 10 * WORKER_UNPROVEN_LIFECYCLE_RECONCILE_AFTER_MS

/**
 * The Postulable row: `worker-start` accepted the prompt, no turn was ever observed, the one-time
 * swallowed-Enter recovery was spent, and the execution host can still not tell us anything.
 */
function unprovenStart(overrides: Partial<FleetDurableWorker> = {}): FleetDurableWorker {
  return {
    dispatchId: 'dispatch-1',
    taskId: 'task-1',
    runId: 'run-1',
    parentTaskId: 'parent-1',
    workerState: 'start_unknown',
    dispatchStatus: 'dispatched',
    workerStage: 'turn_start_unobserved',
    workerUpdatedAt: new Date(NOW - WORKER_UNPROVEN_LIFECYCLE_RECONCILE_AFTER_MS - 1).toISOString(),
    agentTerminalHandle: 'term-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'workspace-1',
    terminalState: 'active',
    resource: null,
    ...overrides
  }
}

function project(worker: FleetDurableWorker, now = NOW) {
  return projectOrchestrationFleet({ workers: [worker], statuses: [], now }).workers[0]!
}

describe('unproven start is never an absorbing lifecycle state', () => {
  // D — the exact Postulable state.
  it('offers an explicit reconciliation once the recovery window is spent', () => {
    const row = project(unprovenStart())

    expect(row.stage.worker).toBe('start_unknown')
    expect(row.outcome).toBe('in_progress')
    expect(row.liveness).toEqual({ verdict: 'unverifiable', reason: 'missing_status' })
    expect(row.nextAction).toEqual({
      kind: 'reconcile',
      argv: ['orchestration', 'worker-abandon', '--dispatch', 'dispatch-1']
    })
  })

  // D — the contradiction that defined the deadlock: the row demanded action and named none.
  it('never asks for action it cannot name', () => {
    const row = project(unprovenStart())

    expect(row.attention.requiresAction).toBe(true)
    expect(row.nextAction.kind).not.toBe('none')
  })

  // Before the window is spent, the row asks for evidence rather than for cleanup.
  it('asks for evidence while the recovery window is still open', () => {
    const row = project(
      unprovenStart({
        workerUpdatedAt: new Date(NOW - 1_000).toISOString()
      })
    )

    expect(row.nextAction).toEqual({
      kind: 'inspect',
      argv: ['orchestration', 'worker-read', '--dispatch', 'dispatch-1']
    })
  })

  // A — the Enter recovery works: the worker leaves `start_unknown` and normal waiting resumes.
  it('asks nothing more once the turn actually starts', () => {
    const row = project(unprovenStart({ workerState: 'ready', workerStage: 'prompt_delivered' }))

    expect(row.nextAction).toEqual({ kind: 'none', argv: [] })
  })

  // B — a positively observed exit keeps the existing failed/recoverable path.
  it('routes a proven exit to recovery rather than reconciliation', () => {
    const row = project(unprovenStart({ terminationReason: 'exited' }))

    expect(row.liveness).toEqual({ verdict: 'exited', source: 'execution_host' })
    expect(row.nextAction).toEqual({
      kind: 'recover',
      argv: ['orchestration', 'worker-read', '--dispatch', 'dispatch-1']
    })
  })

  // A settled Dispatch is resolved; reconciliation is not owed and must not be offered.
  it.each(['succeeded', 'failed', 'stopped', 'abandoned'])(
    'never offers reconciliation for a %s worker',
    (workerState) => {
      const row = project(
        unprovenStart({ workerState, dispatchStatus: 'completed', terminalState: 'retained' })
      )

      expect(row.nextAction.kind).not.toBe('reconcile')
    }
  )

  // The totality requirement: no unresolved combination may project `none`.
  it('is total over every unresolved unproven-lifecycle combination', () => {
    const ages = [0, 1_000, WORKER_UNPROVEN_LIFECYCLE_RECONCILE_AFTER_MS * 100]
    for (const workerState of ['start_unknown', 'stop_unknown']) {
      for (const dispatchStatus of ['pending', 'dispatched']) {
        for (const workerUpdatedAt of [
          ...ages.map((age) => new Date(NOW - age).toISOString()),
          null,
          'not-a-timestamp'
        ]) {
          for (const pendingInput of [false, true]) {
            const row = project(
              unprovenStart({
                workerState,
                dispatchStatus,
                workerUpdatedAt,
                pendingInput
              })
            )

            expect(row.liveness.verdict).toBe('unverifiable')
            expect(row.nextAction.kind).not.toBe('none')
            expect(row.nextAction.argv.length).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  // An unreadable age cannot prove the window is still open, so the safe action stays reachable.
  it.each([null, undefined, 'not-a-timestamp'])(
    'still reaches reconciliation when the state age reads %s',
    (workerUpdatedAt) => {
      const row = project(unprovenStart({ workerUpdatedAt }))

      expect(row.nextAction.kind).toBe('reconcile')
    }
  )
})

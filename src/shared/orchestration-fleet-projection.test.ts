import { describe, expect, it } from 'vitest'
import {
  projectOrchestrationFleet,
  type FleetDurableWorker
} from './orchestration-fleet-projection'

function worker(id: string, overrides: Partial<FleetDurableWorker> = {}): FleetDurableWorker {
  return {
    dispatchId: id,
    taskId: `task-${id}`,
    runId: 'run-1',
    parentTaskId: null,
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    workerStage: 'prompt_delivered',
    agentTerminalHandle: `term-${id}`,
    paneKey: `tab-${id}:leaf-${id}`,
    worktreeId: `workspace-${id}`,
    terminalState: 'active',
    resource: null,
    ...overrides
  }
}

describe('fleet liveness and attention after a host verdict', () => {
  it('refuses to certify a process_exited stage whose cause was never observed', () => {
    const projected = projectOrchestrationFleet({
      workers: [
        worker('1', {
          workerStage: 'process_exited',
          workerState: 'failed',
          terminationReason: 'unknown'
        })
      ],
      statuses: [],
      now: 10_000
    })
    expect(projected.workers[0]!.liveness).toEqual({
      verdict: 'unverifiable',
      reason: 'missing_status'
    })
    // `recover` is reserved for a proven exit; worker-show would only restate this row.
    expect(projected.workers[0]!.nextAction).toEqual({ kind: 'none', argv: [] })
  })

  // Keep open, --keep-open and new-workspace workers stay open on purpose; a release hint would close them.
  it('asks nothing of a finished worker kept open', () => {
    const projected = projectOrchestrationFleet({
      workers: [
        worker('1', {
          workerState: 'succeeded',
          dispatchStatus: 'completed',
          terminalState: 'retained',
          resource: {
            id: 'resource-1',
            ownerDispatchId: '1',
            worktreeId: 'workspace-1',
            paneKey: 'tab-1:leaf-1',
            hostScope: null,
            ownershipState: 'owned',
            releaseState: 'retained',
            updatedAt: '2026-09-04T00:00:00.000Z'
          }
        })
      ],
      statuses: [],
      now: 10_000
    })

    expect(projected.workers[0]!.nextAction).toEqual({ kind: 'none', argv: [] })
  })
})

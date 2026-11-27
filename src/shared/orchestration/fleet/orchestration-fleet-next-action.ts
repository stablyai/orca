import { isUnsupervisedSettledDispatch } from './orchestration-fleet-outcome-resolution'
import type {
  FleetDurableWorker,
  FleetLiveness,
  FleetNextAction
} from './orchestration-fleet-projection'

/** Worker states that carry an outcome; anything else is still supposed to be running. */
export const SETTLED_WORKER_STATES = new Set(['succeeded', 'failed', 'stopped', 'abandoned'])

/** Recompute after host verdicts; stale local inspect must not outrank recover for proven remote exit. */
export function projectFleetNextAction(
  worker: FleetDurableWorker,
  liveness: FleetLiveness,
  canResume = false
): FleetNextAction {
  if (worker.workerStage === 'released') {
    return { kind: 'none', argv: [] }
  }
  if (worker.resource?.autoReleaseAt) {
    return { kind: 'none', argv: [] }
  }
  if (worker.terminalState === 'reclaimable') {
    return {
      kind: 'release',
      argv: ['orchestration', 'worker-release', '--dispatch', worker.dispatchId]
    }
  }
  // Legacy settled dispatches with no resource/worker have nothing to release; inspect would loop.
  if (
    worker.terminalState === 'released' ||
    (worker.dispatchStatus === 'completed' &&
      (!worker.agentTerminalHandle || (isUnsupervisedSettledDispatch(worker) && !worker.resource)))
  ) {
    return { kind: 'none', argv: [] }
  }
  // Settled workers owe only the release of a terminal they still own and nobody kept open; worker-show would repeat the settlement.
  if (SETTLED_WORKER_STATES.has(worker.workerState)) {
    return worker.resource?.ownershipState === 'owned' &&
      worker.resource.releaseState !== 'released' &&
      worker.resource.releaseState !== 'retained'
      ? {
          kind: 'release',
          argv: ['orchestration', 'worker-release', '--dispatch', worker.dispatchId]
        }
      : { kind: 'none', argv: [] }
  }
  // An unverified absence cannot authorize recovery.
  if (
    liveness.verdict === 'exited' &&
    !SETTLED_WORKER_STATES.has(worker.workerState) &&
    !worker.pendingInput &&
    !worker.pendingApproval
  ) {
    return {
      kind: 'recover',
      argv: canResume
        ? [
            'orchestration',
            'send',
            '--to',
            `dispatch:${worker.dispatchId}`,
            '--subject',
            'Continue',
            '--body',
            'Continue the interrupted task.'
          ]
        : ['orchestration', 'worker-read', '--dispatch', worker.dispatchId]
    }
  }
  // Live workers with no pending input owe no action; inspect would repeat this projection.
  if (
    liveness.verdict === 'live' &&
    worker.workerState === 'ready' &&
    !worker.pendingInput &&
    !worker.pendingApproval
  ) {
    return { kind: 'none', argv: [] }
  }
  // worker-show repeats this projection; absence alone cannot earn another command.
  if (liveness.verdict === 'unverifiable' && !worker.pendingInput && !worker.pendingApproval) {
    return { kind: 'none', argv: [] }
  }
  return {
    kind: 'inspect',
    argv: ['orchestration', 'worker-show', '--dispatch', worker.dispatchId]
  }
}

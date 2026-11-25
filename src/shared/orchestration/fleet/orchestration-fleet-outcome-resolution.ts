/** Share outcome precedence across worker-list/show and fleet; separate ladders disagreed on pre-v3 rows. */

export type FleetAttemptOutcome =
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'finished_unverified'

/** `stopped`: someone asked for the stop, so it is no failure even though the stop fails the Dispatch. */
export type FleetWorkerOutcome = FleetAttemptOutcome | 'stopped'

export type FleetSettlementSubject = {
  /** `unsupervised` from the list query's COALESCE, `null` from the attention-fact query. */
  workerState?: string | null
  dispatchStatus?: string | null
}

const SETTLED_DISPATCH_STATUSES = new Set(['completed', 'failed', 'circuit_broken'])

/** No `worker_dispatches` row exists for this Dispatch. */
export function isUnsupervisedWorker(workerState: string | null | undefined): boolean {
  return workerState == null || workerState === 'unsupervised'
}

/** Pre-v3 or task-settled dispatches may lack worker rows; no supervised process means absence adds no news. */
export function isUnsupervisedSettledDispatch(subject: FleetSettlementSubject): boolean {
  return (
    isUnsupervisedWorker(subject.workerState) &&
    SETTLED_DISPATCH_STATUSES.has(subject.dispatchStatus ?? '')
  )
}

/**
 * `attemptOutcome` is the attempt-observation projection; `undefined` means the caller had none.
 * Anything it settled on wins, and the durable dispatch/worker rows answer the rest.
 */
export function resolveFleetWorkerOutcome(args: {
  attemptOutcome?: FleetWorkerOutcome
  workerState?: string | null
  dispatchStatus?: string | null
}): FleetWorkerOutcome {
  const { attemptOutcome, workerState, dispatchStatus } = args
  // Only a worker stop settles `stopped`; it fails a still-active Dispatch with `last_failure: 'stopped'`, rows written before this included.
  if (workerState === 'stopped' && attemptOutcome !== 'succeeded' && attemptOutcome !== 'failed') {
    return 'stopped'
  }
  if (attemptOutcome && attemptOutcome !== 'outcome_unknown') {
    return attemptOutcome
  }
  if (workerState === 'succeeded') {
    return 'succeeded'
  }
  if (workerState === 'failed' || dispatchStatus === 'failed') {
    return 'failed'
  }
  // Completed comes from accepted success or Task completion; without a worker row it is the whole settlement, including pre-v3 dispatches.
  if (dispatchStatus === 'completed' && isUnsupervisedWorker(workerState)) {
    return 'succeeded'
  }
  if (dispatchStatus === 'pending' || dispatchStatus === 'dispatched') {
    return 'in_progress'
  }
  return attemptOutcome ?? 'in_progress'
}

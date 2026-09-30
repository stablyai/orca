/** One reading of "what happened to this Dispatch", shared by worker-list, worker-show and the
 *  fleet projection. Three copies of this ladder disagreed on pre-v3 rows. */

export type FleetAttemptOutcome =
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'finished_unverified'

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

/** A settled Dispatch that never had a worker row: pre-v3, or settled with the Task before a
 *  worker was ever started. There is no supervised process, so absence of one is not news. */
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
  attemptOutcome?: FleetAttemptOutcome
  workerState?: string | null
  dispatchStatus?: string | null
}): FleetAttemptOutcome {
  const { attemptOutcome, workerState, dispatchStatus } = args
  if (attemptOutcome && attemptOutcome !== 'outcome_unknown') {
    return attemptOutcome
  }
  if (workerState === 'succeeded') {
    return 'succeeded'
  }
  if (workerState === 'failed' || dispatchStatus === 'failed') {
    return 'failed'
  }
  // `dispatch_contexts.status = 'completed'` is only ever written from an accepted `succeeded`
  // worker report or a Task completion. With no worker row that record is the whole settlement,
  // and reading it as unknown reported every pre-v3 Dispatch as needing attention forever.
  if (dispatchStatus === 'completed' && isUnsupervisedWorker(workerState)) {
    return 'succeeded'
  }
  if (dispatchStatus === 'pending' || dispatchStatus === 'dispatched') {
    return 'in_progress'
  }
  return attemptOutcome ?? 'in_progress'
}

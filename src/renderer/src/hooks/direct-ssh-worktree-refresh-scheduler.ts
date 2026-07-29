import type {
  HostQualifiedDetectedWorktreeResult,
  ProviderRequestId
} from '../../../shared/detected-worktree-provider-contract'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type {
  DirectSshWorktreeRefreshAttempt,
  DirectSshWorktreeRefreshKey,
  DirectSshWorktreeRefreshLease,
  DirectSshWorktreeRefreshLogicalTask as LogicalTask,
  DirectSshWorktreeRefreshOutcome,
  DirectSshWorktreeRefreshReleaseReason,
  DirectSshWorktreeRefreshScheduler,
  DirectSshWorktreeRefreshSchedulerDeps,
  WaiterLeaseId
} from './direct-ssh-worktree-refresh-scheduler-types'
import { cancelDirectSshWorktreeRefreshAttempt } from './direct-ssh-worktree-refresh-scheduler-cancellation'
import {
  adjustDirectSshAuthorityUnsettled,
  copyDirectSshWorktreeRefreshMetrics,
  createDirectSshWorktreeRefreshMetrics,
  directSshWorktreeRefreshSchedulerSnapshot,
  recordDirectSshCancelDebt,
  recordDirectSshProviderExecution,
  recordDirectSshQueueAdmission
} from './direct-ssh-worktree-refresh-scheduler-metrics'
import { DirectSshWorktreeRefreshTargetQueue } from './direct-ssh-worktree-refresh-target-queue'
import {
  directSshProviderAuthorityKey,
  directSshWorktreeRefreshKey
} from './direct-ssh-worktree-refresh-scheduler-types'
export type * from './direct-ssh-worktree-refresh-scheduler-types'

export const DIRECT_SSH_WORKTREE_SCAN_CONCURRENCY = 5
export const DIRECT_SSH_PROVIDER_START_BUDGET = 7

export function createDirectSshWorktreeRefreshScheduler(
  deps: DirectSshWorktreeRefreshSchedulerDeps
): DirectSshWorktreeRefreshScheduler {
  const now = deps.now ?? Date.now
  const tasksByKey = new Map<string, LogicalTask>()
  const targetQueue = new DirectSshWorktreeRefreshTargetQueue()
  const unsettledByAuthority = new Map<string, number>()
  const cancelDebtByAuthority = new Map<string, number>()
  let locallyUnsettled = 0
  let leaseSequence = 0
  let stopped = false

  const createLeaseId = (): WaiterLeaseId =>
    deps.createWaiterLeaseId?.() ?? (`direct-ssh-waiter-${++leaseSequence}` as WaiterLeaseId)

  const metricsFor = (
    task: LogicalTask,
    locallySettledWaiterCount = task.metrics.locallySettledWaiterCount
  ): DirectSshWorktreeRefreshOutcome['metrics'] => {
    const metrics = copyDirectSshWorktreeRefreshMetrics(task.metrics)
    metrics.locallySettledWaiterCount = locallySettledWaiterCount
    return metrics
  }

  const finishTask = (task: LogicalTask, outcome: DirectSshWorktreeRefreshOutcome): void => {
    if (task.state === 'terminal') {
      return
    }
    task.state = 'terminal'
    task.attempt = null
    tasksByKey.delete(task.keyId)
    task.metrics.locallySettledWaiterCount += task.waiters.size
    const settledOutcome = { ...outcome, metrics: metricsFor(task) }
    for (const waiter of task.waiters.values()) {
      waiter.resolve(settledOutcome)
    }
    task.waiters.clear()
  }

  const addCancelDebt = (task: LogicalTask): void => {
    recordDirectSshCancelDebt(
      task.metrics,
      DIRECT_SSH_PROVIDER_START_BUDGET - DIRECT_SSH_WORKTREE_SCAN_CONCURRENCY
    )
    cancelDebtByAuthority.set(
      task.authorityId,
      (cancelDebtByAuthority.get(task.authorityId) ?? 0) + 1
    )
  }

  const cancelAttempt = (
    task: LogicalTask,
    reason: DirectSshWorktreeRefreshReleaseReason
  ): void => {
    if (!task.attempt || task.attemptCanceled) {
      return
    }
    task.attemptCanceled = true
    if (cancelDirectSshWorktreeRefreshAttempt(task.attempt, reason)) {
      addCancelDebt(task)
    }
  }

  const canStart = (task: LogicalTask): boolean => {
    const unsettled = unsettledByAuthority.get(task.authorityId) ?? 0
    const debt = cancelDebtByAuthority.get(task.authorityId) ?? 0
    return unsettled + debt + 1 <= DIRECT_SSH_PROVIDER_START_BUDGET
  }

  const handleAttemptResult = (
    task: LogicalTask,
    requestId: ProviderRequestId,
    result: HostQualifiedDetectedWorktreeResult
  ): void => {
    if (task.state === 'terminal' || task.attempt?.providerRequestId !== requestId) {
      return
    }
    if (result.providerRequestId !== requestId) {
      finishTask(task, { status: 'rejected', providerRequestId: requestId })
      return
    }
    if (result.status === 'timed-out') {
      addCancelDebt(task)
      if (task.attemptCount === 1) {
        task.metrics.timeoutRetryCount++
        task.attempt = null
        task.attemptCanceled = true
        targetQueue.enqueue(task, true, now())
        return
      }
    }
    const status =
      result.status === 'authority-unknown' || result.status === 'ambiguous-owner'
        ? 'non-authoritative'
        : result.status
    finishTask(task, {
      status,
      providerRequestId: result.providerRequestId,
      providerResult: result
    })
  }

  function drain(): void {
    while (!stopped && locallyUnsettled < DIRECT_SSH_WORKTREE_SCAN_CONCURRENCY) {
      const task = targetQueue.takeNext()
      if (!task) {
        return
      }
      if (!canStart(task)) {
        task.metrics.replacementAdmissionDelayedCount++
        finishTask(task, { status: 'cancel-budget-exhausted' })
        continue
      }
      task.state = 'running'
      task.attemptCount++
      locallyUnsettled++
      recordDirectSshQueueAdmission(
        task.metrics,
        Math.max(0, now() - task.queuedAt),
        locallyUnsettled
      )
      adjustDirectSshAuthorityUnsettled(unsettledByAuthority, task.authorityId, 1)
      let attempt: DirectSshWorktreeRefreshAttempt
      try {
        attempt = deps.startAttempt(task.key)
        task.attempt = attempt
        task.attemptCanceled = false
        task.attemptStartedAt = now()
      } catch (error) {
        locallyUnsettled--
        adjustDirectSshAuthorityUnsettled(unsettledByAuthority, task.authorityId, -1)
        deps.onUnexpectedError?.(error)
        finishTask(task, { status: 'rejected' })
        continue
      }
      void attempt.result
        .then((result) => {
          if (task.attemptStartedAt !== null) {
            recordDirectSshProviderExecution(
              task.metrics,
              Math.max(0, now() - task.attemptStartedAt)
            )
            task.attemptStartedAt = null
          }
          handleAttemptResult(task, attempt.providerRequestId, result)
        })
        .catch((error) => {
          if (task.attemptStartedAt !== null) {
            recordDirectSshProviderExecution(
              task.metrics,
              Math.max(0, now() - task.attemptStartedAt)
            )
            task.attemptStartedAt = null
          }
          if (task.state !== 'terminal' && !task.attemptCanceled) {
            deps.onUnexpectedError?.(error)
            finishTask(task, {
              status: 'rejected',
              providerRequestId: attempt.providerRequestId
            })
          }
        })
        .finally(() => {
          locallyUnsettled--
          adjustDirectSshAuthorityUnsettled(unsettledByAuthority, task.authorityId, -1)
          drain()
        })
    }
  }

  const releaseWaiter = (
    task: LogicalTask,
    waiterLeaseId: WaiterLeaseId,
    reason: DirectSshWorktreeRefreshReleaseReason
  ): void => {
    const waiter = task.waiters.get(waiterLeaseId)
    if (!waiter) {
      return
    }
    task.waiters.delete(waiterLeaseId)
    task.metrics.locallySettledWaiterCount++
    waiter.resolve({ status: 'canceled', metrics: metricsFor(task) })
    if (task.waiters.size > 0) {
      return
    }
    cancelAttempt(task, reason)
    finishTask(task, { status: 'canceled' })
  }

  const request = (key: DirectSshWorktreeRefreshKey): DirectSshWorktreeRefreshLease => {
    const keyId = directSshWorktreeRefreshKey(key)
    let task = tasksByKey.get(keyId)
    if (!task) {
      const requestedAt = now()
      task = {
        key,
        keyId,
        authorityId: directSshProviderAuthorityKey(key),
        state: 'queued',
        attemptCount: 0,
        attempt: null,
        attemptCanceled: false,
        attemptStartedAt: null,
        queuedAt: requestedAt,
        metrics: createDirectSshWorktreeRefreshMetrics(),
        waiters: new Map()
      }
      tasksByKey.set(keyId, task)
      targetQueue.enqueue(task, false, now())
    } else {
      task.metrics.overlappingJoinCount++
    }
    const waiterLeaseId = createLeaseId()
    let resolve!: (outcome: DirectSshWorktreeRefreshOutcome) => void
    const result = new Promise<DirectSshWorktreeRefreshOutcome>((settle) => {
      resolve = settle
    })
    task.waiters.set(waiterLeaseId, { resolve })
    if (stopped) {
      releaseWaiter(task, waiterLeaseId, 'stopped')
      targetQueue.clear()
    } else {
      drain()
    }
    return {
      waiterLeaseId,
      result,
      release: (reason) => releaseWaiter(task!, waiterLeaseId, reason)
    }
  }

  const invalidateMatching = (predicate: (task: LogicalTask) => boolean): void => {
    for (const task of tasksByKey.values()) {
      if (!predicate(task)) {
        continue
      }
      cancelAttempt(task, 'invalidated')
      finishTask(task, { status: 'stale', providerRequestId: task.attempt?.providerRequestId })
    }
    drain()
  }

  const invalidateAuthority = (authority: DirectSshAuthority): void => {
    const id = directSshProviderAuthorityKey(authority)
    invalidateMatching((task) => task.authorityId === id)
  }

  const invalidateTarget = (targetId: string): void => {
    invalidateMatching((task) => task.key.targetId === targetId)
  }

  const disposeProvider = (authority: DirectSshAuthority): void => {
    invalidateAuthority(authority)
    cancelDebtByAuthority.delete(directSshProviderAuthorityKey(authority))
  }

  const getSnapshot = () =>
    directSshWorktreeRefreshSchedulerSnapshot(tasksByKey, locallyUnsettled, cancelDebtByAuthority)

  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    for (const task of tasksByKey.values()) {
      cancelAttempt(task, 'stopped')
      finishTask(task, { status: 'canceled', providerRequestId: task.attempt?.providerRequestId })
    }
    targetQueue.clear()
  }

  return {
    request,
    invalidateAuthority,
    invalidateTarget,
    disposeProvider,
    getSnapshot,
    stop
  }
}

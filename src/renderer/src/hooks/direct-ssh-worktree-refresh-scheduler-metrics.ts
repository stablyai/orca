import type {
  DirectSshWorktreeRefreshLogicalTask,
  DirectSshWorktreeRefreshMetrics,
  DirectSshWorktreeRefreshSchedulerSnapshot
} from './direct-ssh-worktree-refresh-scheduler-types'

export function createDirectSshWorktreeRefreshMetrics(): DirectSshWorktreeRefreshMetrics {
  return {
    queueWaitDurationsMs: [],
    providerExecutionDurationsMs: [],
    timeoutRetryCount: 0,
    locallySettledWaiterCount: 0,
    cancelDebtCount: 0,
    replacementAdmissionDelayedCount: 0,
    overlappingJoinCount: 0,
    peakLocallyUnsettled: 0,
    estimatedLateWorkAllowanceCount: 0
  }
}

export function adjustDirectSshAuthorityUnsettled(
  unsettledByAuthority: Map<string, number>,
  authorityId: string,
  delta: number
): void {
  const next = (unsettledByAuthority.get(authorityId) ?? 0) + delta
  if (next > 0) {
    unsettledByAuthority.set(authorityId, next)
  } else {
    unsettledByAuthority.delete(authorityId)
  }
}

export function copyDirectSshWorktreeRefreshMetrics(
  metrics: DirectSshWorktreeRefreshMetrics
): DirectSshWorktreeRefreshMetrics {
  return {
    ...metrics,
    queueWaitDurationsMs: [...metrics.queueWaitDurationsMs],
    providerExecutionDurationsMs: [...metrics.providerExecutionDurationsMs]
  }
}

export function recordDirectSshCancelDebt(
  metrics: DirectSshWorktreeRefreshMetrics,
  lateWorkLimit: number
): void {
  metrics.cancelDebtCount++
  metrics.estimatedLateWorkAllowanceCount = Math.min(
    lateWorkLimit,
    metrics.estimatedLateWorkAllowanceCount + 1
  )
}

export function recordDirectSshQueueAdmission(
  metrics: DirectSshWorktreeRefreshMetrics,
  queueWaitDurationMs: number,
  locallyUnsettled: number
): void {
  metrics.queueWaitDurationsMs = [...metrics.queueWaitDurationsMs, queueWaitDurationMs]
  metrics.peakLocallyUnsettled = Math.max(metrics.peakLocallyUnsettled, locallyUnsettled)
}

export function recordDirectSshProviderExecution(
  metrics: DirectSshWorktreeRefreshMetrics,
  providerExecutionDurationMs: number
): void {
  metrics.providerExecutionDurationsMs = [
    ...metrics.providerExecutionDurationsMs,
    providerExecutionDurationMs
  ]
}

export function directSshWorktreeRefreshSchedulerSnapshot(
  tasks: ReadonlyMap<string, DirectSshWorktreeRefreshLogicalTask>,
  locallyUnsettled: number,
  cancelDebtByAuthority: ReadonlyMap<string, number>
): DirectSshWorktreeRefreshSchedulerSnapshot {
  let queued = 0
  let retrying = 0
  let waiters = 0
  for (const task of tasks.values()) {
    queued += task.state === 'queued' ? 1 : 0
    retrying += task.state === 'retrying' ? 1 : 0
    waiters += task.waiters.size
  }
  return {
    locallyUnsettled,
    queued,
    retrying,
    logicalTasks: tasks.size,
    waiters,
    cancelDebtByAuthority: new Map(cancelDebtByAuthority)
  }
}

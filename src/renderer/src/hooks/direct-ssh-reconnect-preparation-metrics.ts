import type { DirectSshWorktreeRefreshOutcome } from './direct-ssh-worktree-refresh-scheduler'
import type { DirectSshPreparationMetrics } from './direct-ssh-reconnect-coordinator-types'
import { createEmptyDirectSshPreparationMetrics } from './direct-ssh-reconnect-coordinator-outcomes'

export function aggregateDirectSshPreparationMetrics(
  outcomes: readonly DirectSshWorktreeRefreshOutcome[],
  joinCount: number
): DirectSshPreparationMetrics {
  const aggregate = createEmptyDirectSshPreparationMetrics()
  for (const outcome of outcomes) {
    const metrics = outcome.metrics
    if (!metrics) {
      continue
    }
    aggregate.queueWaitDurationsMs = [
      ...aggregate.queueWaitDurationsMs,
      ...metrics.queueWaitDurationsMs
    ]
    aggregate.providerExecutionDurationsMs = [
      ...aggregate.providerExecutionDurationsMs,
      ...metrics.providerExecutionDurationsMs
    ]
    aggregate.timeoutRetryCount += metrics.timeoutRetryCount
    aggregate.locallySettledWaiterCount += metrics.locallySettledWaiterCount
    aggregate.cancelDebtCount += metrics.cancelDebtCount
    aggregate.replacementAdmissionDelayedCount += metrics.replacementAdmissionDelayedCount
    aggregate.schedulerOverlappingJoinCount += metrics.overlappingJoinCount
    aggregate.peakLocallyUnsettled = Math.max(
      aggregate.peakLocallyUnsettled,
      metrics.peakLocallyUnsettled
    )
    aggregate.estimatedLateWorkAllowanceCount = Math.max(
      aggregate.estimatedLateWorkAllowanceCount,
      metrics.estimatedLateWorkAllowanceCount
    )
  }
  aggregate.schedulerOverlappingJoinCount += joinCount
  return aggregate
}

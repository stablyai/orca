import type { DirectSshCoordinatorTelemetry } from '../hooks/direct-ssh-reconnect-coordinator'
import { track } from './telemetry'
import type {
  DirectSshReconnectProductProps,
  DirectSshReconnectProductSink
} from './direct-ssh-reconnect-product-telemetry-types'

const MAX_COUNT = 1_000_000
const MAX_DURATION_MS = 86_400_000

function boundedInteger(value: number, maximum = MAX_COUNT): number {
  return Math.min(maximum, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)))
}

function durationDistribution(values: readonly number[]): {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
} {
  const sorted = values
    .map((value) => boundedInteger(value, MAX_DURATION_MS))
    .toSorted((a, b) => a - b)
  const percentile = (quantile: number): number =>
    sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]
  return {
    count: boundedInteger(sorted.length),
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? 0
  }
}

function lineageCounts(
  outcome: DirectSshCoordinatorTelemetry['lineageOutcome']
): Pick<
  DirectSshReconnectProductProps,
  | 'lineage_complete_count'
  | 'lineage_degraded_count'
  | 'lineage_canceled_count'
  | 'lineage_stale_count'
  | 'lineage_not_started_count'
> {
  return {
    lineage_complete_count: outcome === 'complete' ? 1 : 0,
    lineage_degraded_count: outcome === 'degraded' ? 1 : 0,
    lineage_canceled_count: outcome === 'canceled' ? 1 : 0,
    lineage_stale_count: outcome === 'stale' ? 1 : 0,
    lineage_not_started_count: outcome === 'not-started' ? 1 : 0
  }
}

export function toDirectSshReconnectProductProps(
  event: DirectSshCoordinatorTelemetry
): DirectSshReconnectProductProps {
  const queueWait = durationDistribution(event.queueWaitDurationsMs)
  const providerExecution = durationDistribution(event.providerExecutionDurationsMs)
  return {
    mode: event.mode === 'prepare-only' ? 'prepare_only' : 'reconnect',
    reason: event.reason.replaceAll('-', '_') as DirectSshReconnectProductProps['reason'],
    outcome: event.outcome,
    terminal_retried_count: boundedInteger(event.retriedTerminals),
    terminal_stale_binding_cleared_count: boundedInteger(event.staleBindingsCleared),
    terminal_correction_succeeded_count: boundedInteger(event.correctedTerminals),
    catalog_complete_count: event.catalogOutcome === 'complete' ? 1 : 0,
    catalog_degraded_count: event.catalogOutcome === 'degraded' ? 1 : 0,
    catalog_stale_count: event.catalogOutcome === 'stale' ? 1 : 0,
    repo_complete_count: boundedInteger(event.repoOutcomes.complete),
    repo_non_authoritative_count: boundedInteger(event.repoOutcomes['non-authoritative']),
    // One first-timeout transition per repo makes retrying repos equal timeout retries.
    repo_retrying_count: boundedInteger(event.timeoutRetryCount),
    repo_timed_out_count: boundedInteger(event.repoOutcomes['timed-out']),
    repo_cancel_budget_exhausted_count: boundedInteger(
      event.repoOutcomes['cancel-budget-exhausted']
    ),
    repo_canceled_count: boundedInteger(event.repoOutcomes.canceled),
    repo_stale_count: boundedInteger(event.repoOutcomes.stale),
    repo_rejected_count: boundedInteger(event.repoOutcomes.rejected),
    ...lineageCounts(event.lineageOutcome),
    git_worktree_count: boundedInteger(event.gitWorktreeCount),
    folder_workspace_count: boundedInteger(event.folderWorkspaceCount),
    ambiguous_owner_count: boundedInteger(event.ambiguousOwnerCount),
    contradictory_owner_count: boundedInteger(event.contradictoryOwnerCount),
    total_duration_ms: boundedInteger(event.durationMs, MAX_DURATION_MS),
    terminal_finalization_duration_ms: boundedInteger(
      event.terminalFinalizationDurationMs,
      MAX_DURATION_MS
    ),
    catalog_duration_ms: boundedInteger(event.catalogDurationMs, MAX_DURATION_MS),
    queue_wait_sample_count: queueWait.count,
    queue_wait_duration_ms_p50: queueWait.p50,
    queue_wait_duration_ms_p95: queueWait.p95,
    queue_wait_duration_ms_p99: queueWait.p99,
    queue_wait_duration_ms_max: queueWait.max,
    provider_execution_sample_count: providerExecution.count,
    provider_execution_duration_ms_p50: providerExecution.p50,
    provider_execution_duration_ms_p95: providerExecution.p95,
    provider_execution_duration_ms_p99: providerExecution.p99,
    provider_execution_duration_ms_max: providerExecution.max,
    timeout_retry_count: boundedInteger(event.timeoutRetryCount),
    locally_settled_waiter_count: boundedInteger(event.locallySettledWaiterCount),
    cancel_debt_count: boundedInteger(event.cancelDebtCount),
    replacement_admission_delayed_count: boundedInteger(event.replacementAdmissionDelayedCount),
    overlapping_join_count: boundedInteger(event.overlappingJoinCount),
    coordinator_owned_direct_ssh_detected_worktree_concurrency_peak: boundedInteger(
      event.peakLocallyUnsettled,
      5
    ),
    estimated_late_work_allowance_count: boundedInteger(event.estimatedLateWorkAllowanceCount, 2),
    authority_rotation_count: boundedInteger(event.authorityRotationCount),
    damped_preparation_count: event.damped ? 1 : 0
  }
}

export function createDirectSshReconnectProductTelemetryAdapter(
  sink: DirectSshReconnectProductSink = track
): (event: DirectSshCoordinatorTelemetry) => void {
  return (event) => {
    try {
      sink('direct_ssh_reconnect_operation', toDirectSshReconnectProductProps(event))
    } catch {
      // Recovery cannot depend on product telemetry.
    }
  }
}

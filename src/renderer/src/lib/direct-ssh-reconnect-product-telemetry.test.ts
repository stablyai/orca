import { describe, expect, it, vi } from 'vitest'
import type { DirectSshCoordinatorTelemetry } from '../hooks/direct-ssh-reconnect-coordinator'
import {
  createDirectSshReconnectProductTelemetryAdapter,
  toDirectSshReconnectProductProps
} from './direct-ssh-reconnect-product-telemetry'

function coordinatorEvent(
  overrides: Partial<DirectSshCoordinatorTelemetry> = {}
): DirectSshCoordinatorTelemetry {
  return {
    mode: 'prepare-only',
    reason: 'workspace-snapshot',
    outcome: 'degraded',
    durationMs: 900,
    staleBindingsCleared: 1,
    retriedTerminals: 2,
    correctedTerminals: 3,
    terminalFinalizationDurationMs: 4,
    catalogOutcome: 'complete',
    catalogDurationMs: 20,
    gitWorktreeCount: 5,
    folderWorkspaceCount: 2,
    ambiguousOwnerCount: 1,
    contradictoryOwnerCount: 1,
    repoOutcomes: {
      complete: 2,
      'non-authoritative': 1,
      'timed-out': 1,
      'cancel-budget-exhausted': 1,
      canceled: 1,
      stale: 1,
      rejected: 1
    },
    lineageOutcome: 'degraded',
    queueWaitDurationsMs: [30, 10, 20, 40],
    providerExecutionDurationsMs: [400, 100, 300, 200],
    timeoutRetryCount: 2,
    locallySettledWaiterCount: 4,
    cancelDebtCount: 2,
    replacementAdmissionDelayedCount: 1,
    overlappingJoinCount: 3,
    peakLocallyUnsettled: 4,
    estimatedLateWorkAllowanceCount: 2,
    authorityRotationCount: 1,
    damped: true,
    ...overrides
  }
}

describe('direct SSH reconnect product telemetry', () => {
  it('maps one coordinator aggregate to privacy-safe product fields', () => {
    const props = toDirectSshReconnectProductProps(coordinatorEvent())

    expect(props).toMatchObject({
      mode: 'prepare_only',
      reason: 'workspace_snapshot',
      outcome: 'degraded',
      repo_retrying_count: 2,
      repo_timed_out_count: 1,
      repo_rejected_count: 1,
      repo_canceled_count: 1,
      repo_stale_count: 1,
      lineage_degraded_count: 1,
      queue_wait_sample_count: 4,
      queue_wait_duration_ms_p50: 20,
      queue_wait_duration_ms_p95: 40,
      provider_execution_sample_count: 4,
      provider_execution_duration_ms_p50: 200,
      provider_execution_duration_ms_p99: 400,
      cancel_debt_count: 2,
      replacement_admission_delayed_count: 1,
      overlapping_join_count: 3,
      timeout_retry_count: 2,
      damped_preparation_count: 1
    })
    expect(Object.keys(props).join(' ')).not.toMatch(
      /target_id|repo_id|host|path|label|user|request_id|lease_id|terminal_id|error/
    )
    expect(props).not.toHaveProperty('terminal_correction_failed_count')
    expect(props).not.toHaveProperty('terminal_correction_rearmed_count')
    expect(props).not.toHaveProperty('concurrent_non_coordinator_call_count')
    expect(props).not.toHaveProperty('arrival_order_reply_discarded_count')
  })

  it('emits exactly one typed event per adapter call', () => {
    const sink = vi.fn()
    const emit = createDirectSshReconnectProductTelemetryAdapter(sink)

    emit(coordinatorEvent())

    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith(
      'direct_ssh_reconnect_operation',
      expect.objectContaining({ total_duration_ms: 900 })
    )
  })

  it('does not let telemetry failures escape into recovery', () => {
    const emit = createDirectSshReconnectProductTelemetryAdapter(() => {
      throw new Error('telemetry unavailable')
    })

    expect(() => emit(coordinatorEvent())).not.toThrow()
  })
})

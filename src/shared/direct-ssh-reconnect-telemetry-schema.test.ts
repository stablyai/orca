import { describe, expect, it } from 'vitest'
import { eventSchemas, type EventProps } from './telemetry-events'

const validEvent = {
  mode: 'reconnect',
  reason: 'wake_refresh',
  outcome: 'degraded',
  terminal_retried_count: 3,
  terminal_stale_binding_cleared_count: 1,
  terminal_correction_succeeded_count: 2,
  catalog_complete_count: 1,
  catalog_degraded_count: 0,
  catalog_stale_count: 0,
  repo_complete_count: 2,
  repo_non_authoritative_count: 1,
  repo_retrying_count: 1,
  repo_timed_out_count: 1,
  repo_cancel_budget_exhausted_count: 0,
  repo_canceled_count: 0,
  repo_stale_count: 0,
  repo_rejected_count: 1,
  lineage_complete_count: 0,
  lineage_degraded_count: 1,
  lineage_canceled_count: 0,
  lineage_stale_count: 0,
  lineage_not_started_count: 0,
  git_worktree_count: 4,
  folder_workspace_count: 2,
  ambiguous_owner_count: 1,
  contradictory_owner_count: 1,
  total_duration_ms: 750,
  terminal_finalization_duration_ms: 5,
  catalog_duration_ms: 25,
  queue_wait_sample_count: 3,
  queue_wait_duration_ms_p50: 10,
  queue_wait_duration_ms_p95: 30,
  queue_wait_duration_ms_p99: 30,
  queue_wait_duration_ms_max: 30,
  provider_execution_sample_count: 3,
  provider_execution_duration_ms_p50: 100,
  provider_execution_duration_ms_p95: 300,
  provider_execution_duration_ms_p99: 300,
  provider_execution_duration_ms_max: 300,
  timeout_retry_count: 1,
  locally_settled_waiter_count: 3,
  cancel_debt_count: 1,
  replacement_admission_delayed_count: 0,
  overlapping_join_count: 1,
  coordinator_owned_direct_ssh_detected_worktree_concurrency_peak: 3,
  estimated_late_work_allowance_count: 1,
  authority_rotation_count: 1,
  damped_preparation_count: 0
} satisfies EventProps<'direct_ssh_reconnect_operation'>

describe('direct SSH reconnect telemetry schema', () => {
  it('accepts the aggregate count and duration distribution', () => {
    expect(eventSchemas.direct_ssh_reconnect_operation.safeParse(validEvent).success).toBe(true)
  })

  it.each([
    'target_id',
    'repo_id',
    'host',
    'path',
    'label',
    'username',
    'request_id',
    'lease_id',
    'terminal_id',
    'error',
    'raw_error'
  ])('rejects identifier or raw failure field %s', (field) => {
    expect(
      eventSchemas.direct_ssh_reconnect_operation.safeParse({
        ...validEvent,
        [field]: 'sensitive-value'
      }).success
    ).toBe(false)
  })

  it('keeps timeout, rejection, cancellation, and stale counts independent', () => {
    const parsed = eventSchemas.direct_ssh_reconnect_operation.parse({
      ...validEvent,
      repo_timed_out_count: 2,
      repo_rejected_count: 3,
      repo_canceled_count: 4,
      repo_stale_count: 5
    })

    expect([
      parsed.repo_timed_out_count,
      parsed.repo_rejected_count,
      parsed.repo_canceled_count,
      parsed.repo_stale_count
    ]).toEqual([2, 3, 4, 5])
  })

  it('rejects concurrency and late-work values beyond scheduler policy', () => {
    expect(
      eventSchemas.direct_ssh_reconnect_operation.safeParse({
        ...validEvent,
        coordinator_owned_direct_ssh_detected_worktree_concurrency_peak: 6
      }).success
    ).toBe(false)
    expect(
      eventSchemas.direct_ssh_reconnect_operation.safeParse({
        ...validEvent,
        estimated_late_work_allowance_count: 3
      }).success
    ).toBe(false)
  })
})

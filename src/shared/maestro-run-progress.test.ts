import { describe, expect, it } from 'vitest'
import {
  MaestroRunProgressV1Schema,
  MaestroRunProgressV2Schema,
  MaestroRunProgressSummarySchema,
  parseNegotiatedMaestroRunProgress,
  unavailableMaestroRunProgress
} from './maestro-run-progress'
import {
  MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY,
  MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY,
  ORCHESTRATION_ACTOR_BOUND_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_NESTED_ACTIVITY_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES,
  WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY
} from './protocol-version'

const summary = {
  schema_version: 1,
  state: 'partial',
  progress_percent: 99,
  task_counts: {
    approved: 4,
    running: 0,
    input_required: 0,
    blocked: 0,
    pending: 0,
    failed: 0
  },
  current_tasks: [],
  next_tasks: [],
  cleanup: {
    pending: { count: 0, ids: [], truncated: false },
    unverifiable: { count: 0, ids: [], truncated: false },
    failed: { count: 0, ids: [], truncated: false },
    retained: { count: 0, ids: [], truncated: false }
  },
  last_activity: { sequence: 12, timestamp: '2026-08-22T09:04:01Z', type: 'result_reported' },
  blockers: [],
  material_findings: [
    { task_id: 'ORC-04P', attempt_id: 'attempt-1', finding_ref: 'finding-1', cleanup_id: null }
  ]
} as const

const authority = {
  runId: 'run-1',
  workspace: { executionHostId: 'host-local', workspaceKey: 'folder:folder-local-01' },
  revision: 4
}

describe('Maestro run progress', () => {
  it('preserves the Harness summary without recomputing carry-forward progress', () => {
    expect(MaestroRunProgressSummarySchema.parse(summary)).toEqual(summary)
  })

  it('bounds Harness-owned references at the protocol boundary', () => {
    expect(() =>
      MaestroRunProgressSummarySchema.parse({
        ...summary,
        current_tasks: Array.from({ length: 4 }, (_, index) => ({
          task_id: `task-${index}`,
          attempt_id: null,
          status: 'running'
        }))
      })
    ).toThrow()
  })

  it('preserves unavailable Harness coordination observations without deriving metrics', () => {
    const coordination = {
      execution_mode: 'single_writer',
      latest_transition_reason: 'Bounded reduction after a failed check.',
      implementation_wall_time_ms: 1200,
      check_wall_time_ms: 'unavailable',
      coordinator_wait_for_worker_wall_time_ms: 300,
      audit_wall_time_ms: 80,
      dispatch_count: 2,
      operational_start_failures: 0,
      technical_attempts: 1,
      token_input: 'unavailable',
      token_output: 'unavailable',
      token_cache: 'unavailable',
      approved_tasks: 4,
      blocking_findings: 0,
      carry_forward_findings: 1,
      durations_diagnostic: true
    } as const

    expect(
      MaestroRunProgressSummarySchema.parse({ ...summary, coordination }).coordination
    ).toEqual(coordination)
  })

  it('rejects token observations outside the negotiated unavailable sentinel', () => {
    expect(() =>
      MaestroRunProgressSummarySchema.parse({
        ...summary,
        coordination: {
          execution_mode: 'single_writer',
          latest_transition_reason: null,
          implementation_wall_time_ms: 'unavailable',
          check_wall_time_ms: 'unavailable',
          coordinator_wait_for_worker_wall_time_ms: 'unavailable',
          audit_wall_time_ms: 'unavailable',
          dispatch_count: 0,
          operational_start_failures: 0,
          technical_attempts: 0,
          token_input: 1,
          token_output: 'unavailable',
          token_cache: 'unavailable',
          approved_tasks: 4,
          blocking_findings: 0,
          carry_forward_findings: 0,
          durations_diagnostic: true
        }
      })
    ).toThrow()
  })

  it('rejects an identity-less Harness reference', () => {
    expect(() =>
      MaestroRunProgressSummarySchema.parse({
        ...summary,
        material_findings: [
          { task_id: null, attempt_id: null, finding_ref: null, cleanup_id: null }
        ]
      })
    ).toThrow()
  })

  it('uses an explicit unavailable boundary for peers without run progress', () => {
    expect(unavailableMaestroRunProgress()).toEqual({ available: false, state: 'outcome_unknown' })
  })

  it.each([
    {
      progress_percent: 100,
      task_counts: { ...summary.task_counts, input_required: 1 },
      current_tasks: [{ task_id: 'ORC-04P', attempt_id: null, status: 'input_required' }]
    },
    {
      progress_percent: 100,
      task_counts: { ...summary.task_counts, blocked: 1 },
      current_tasks: [{ task_id: 'ORC-04P', attempt_id: null, status: 'blocked' }]
    },
    {
      progress_percent: 100,
      task_counts: { ...summary.task_counts, failed: 1 },
      current_tasks: [{ task_id: 'ORC-04P', attempt_id: null, status: 'failed' }]
    },
    {
      progress_percent: 100,
      task_counts: { ...summary.task_counts, running: 1 },
      current_tasks: [{ task_id: 'ORC-04P', attempt_id: null, status: 'running' }]
    },
    {
      progress_percent: 100,
      task_counts: { ...summary.task_counts, pending: 1 },
      next_tasks: [{ task_id: 'ORC-04P', attempt_id: null, status: 'pending' }]
    },
    {
      progress_percent: 100,
      cleanup: {
        ...summary.cleanup,
        retained: { count: 1, ids: ['cleanup-1'], truncated: false }
      }
    },
    { progress_percent: 100, material_findings: summary.material_findings }
  ])('rejects complete progress with unresolved canonical state', (contradiction) => {
    expect(() =>
      MaestroRunProgressSummarySchema.parse({
        ...summary,
        state: 'complete',
        ...contradiction
      })
    ).toThrow()
  })

  it('degrades invalid or unsupported negotiated versions without rejecting the graph', () => {
    expect(parseNegotiatedMaestroRunProgress({ ...summary, schema_version: 2 }, authority)).toEqual(
      { available: false, state: 'outcome_unknown' }
    )
    expect(parseNegotiatedMaestroRunProgress(undefined, null)).toEqual({
      available: false,
      state: 'outcome_unknown'
    })
  })
})

const completedProgressV2 = {
  schema_version: 2,
  run: { id: 'run-1', title: 'Harden orchestration contracts' },
  execution: {
    state: 'completed',
    progress_percent: 100,
    completed: 2,
    total: 2,
    counts: {
      pending: 0,
      running: 0,
      input_required: 0,
      blocked: 0,
      succeeded: 2,
      failed: 0,
      cancelled: 0
    }
  },
  projection_health: {
    state: 'partial',
    revision: 4,
    warning: 'The projected Canvas is missing one optional surface binding.'
  },
  cleanup_health: {
    state: 'unverifiable',
    count: 1,
    warning: 'One remote worker cannot be verified after disconnect.'
  },
  current: [],
  recently_completed: [
    {
      reference: 'task-1',
      title: 'Define shared contracts',
      worker_label: 'Contract writer',
      outcome_summary: 'Published strict receipt and progress schemas.'
    }
  ],
  next: [],
  blocked: [],
  nested_activity: [],
  technical: {
    execution_host_id: 'host-local',
    workspace_key: 'worktree:repo-1',
    run_id: 'run-1',
    revision: 4
  }
} as const

describe('Maestro Run progress v2 compatibility', () => {
  it('advertises each additive hardening capability', () => {
    expect(RUNTIME_CAPABILITIES).toEqual(
      expect.arrayContaining([
        WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY,
        MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY,
        ORCHESTRATION_ACTOR_BOUND_SETTLEMENT_RUNTIME_CAPABILITY,
        ORCHESTRATION_NESTED_ACTIVITY_RUNTIME_CAPABILITY,
        MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY
      ])
    )
  })

  it('preserves the negotiated v1 reader', () => {
    expect(MaestroRunProgressV1Schema.parse(summary)).toEqual(summary)
    expect(parseNegotiatedMaestroRunProgress(summary, 1)).toEqual(summary)
    expect(() => parseNegotiatedMaestroRunProgress(summary, 2)).toThrow()
  })

  it('keeps terminal Task progress independent from projection and cleanup health', () => {
    expect(MaestroRunProgressV2Schema.parse(completedProgressV2)).toEqual(completedProgressV2)
  })

  it('omits percentage for a zero-Task Run', () => {
    const zeroTaskProgress = {
      ...completedProgressV2,
      execution: {
        state: 'outcome_unknown',
        completed: 0,
        total: 0,
        counts: {
          pending: 0,
          running: 0,
          input_required: 0,
          blocked: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0
        }
      }
    }
    expect(MaestroRunProgressV2Schema.safeParse(zeroTaskProgress).success).toBe(true)
    expect(
      MaestroRunProgressV2Schema.safeParse({
        ...zeroTaskProgress,
        execution: { ...zeroTaskProgress.execution, progress_percent: 0 }
      }).success
    ).toBe(false)
  })

  it('rejects contradictory completion and authored percentages', () => {
    expect(
      MaestroRunProgressV2Schema.safeParse({
        ...completedProgressV2,
        execution: { ...completedProgressV2.execution, progress_percent: 90 }
      }).success
    ).toBe(false)
    expect(
      MaestroRunProgressV2Schema.safeParse({
        ...completedProgressV2,
        execution: { ...completedProgressV2.execution, state: 'active' }
      }).success
    ).toBe(false)
  })

  it('distinguishes terminal failures and cancellation from success', () => {
    const failureCounts = { ...completedProgressV2.execution.counts, succeeded: 1, failed: 1 }
    expect(
      MaestroRunProgressV2Schema.safeParse({
        ...completedProgressV2,
        execution: {
          ...completedProgressV2.execution,
          state: 'completed_with_failures',
          counts: failureCounts
        }
      }).success
    ).toBe(true)
    expect(
      MaestroRunProgressV2Schema.safeParse({
        ...completedProgressV2,
        execution: {
          ...completedProgressV2.execution,
          state: 'cancelled',
          counts: { ...failureCounts, failed: 0, cancelled: 1 }
        }
      }).success
    ).toBe(true)
  })

  it('rejects cross-run identity and unbounded summaries', () => {
    expect(
      MaestroRunProgressV2Schema.safeParse({
        ...completedProgressV2,
        technical: { ...completedProgressV2.technical, run_id: 'run-other' }
      }).success
    ).toBe(false)
    expect(
      MaestroRunProgressV2Schema.safeParse({
        ...completedProgressV2,
        run: { ...completedProgressV2.run, title: 'x'.repeat(2_049) }
      }).success
    ).toBe(false)
  })
})

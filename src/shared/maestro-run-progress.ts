import { z } from 'zod'
import { MaestroRunProgressV2Schema, type MaestroRunProgressV2 } from './maestro-run-progress-v2'

export {
  MAESTRO_RUN_PROGRESS_LIST_LIMIT,
  MAESTRO_RUN_PROGRESS_TEXT_MAX_LENGTH,
  MaestroRunProgressV2Schema
} from './maestro-run-progress-v2'

export const MAESTRO_RUN_PROGRESS_NODE_PREFIX = 'run-progress-'

const RunProgressStateSchema = z.enum([
  'active',
  'input_required',
  'blocked',
  'partial',
  'complete',
  'failed',
  'outcome_unknown'
])

const RunProgressReferenceSchema = z
  .object({
    task_id: z.string().nullable(),
    attempt_id: z.string().nullable(),
    finding_ref: z.string().nullable(),
    cleanup_id: z.string().nullable()
  })
  .strict()
  .refine(
    (reference) =>
      reference.task_id !== null ||
      reference.attempt_id !== null ||
      reference.finding_ref !== null ||
      reference.cleanup_id !== null,
    { message: 'Run progress references require an identity.' }
  )

const RunProgressTaskReferenceSchema = z
  .object({
    task_id: z.string(),
    attempt_id: z.string().nullable(),
    status: z.enum(['running', 'input_required', 'blocked', 'pending', 'failed'])
  })
  .strict()

const RunProgressCleanupGroupSchema = z
  .object({
    count: z.number().int().min(0),
    ids: z.array(z.string()).max(5),
    truncated: z.boolean()
  })
  .strict()

const RunProgressActivitySchema = z
  .object({
    sequence: z.number().int().min(1),
    timestamp: z.string(),
    type: z.string()
  })
  .strict()

const RunProgressWallTimeSchema = z.union([z.literal('unavailable'), z.number().int().min(0)])

const RunProgressCoordinationSchema = z
  .object({
    execution_mode: z.enum(['single_writer', 'parallel']),
    latest_transition_reason: z.string().nullable(),
    implementation_wall_time_ms: RunProgressWallTimeSchema,
    check_wall_time_ms: RunProgressWallTimeSchema,
    coordinator_wait_for_worker_wall_time_ms: RunProgressWallTimeSchema,
    audit_wall_time_ms: RunProgressWallTimeSchema,
    dispatch_count: z.number().int().min(0),
    operational_start_failures: z.number().int().min(0),
    technical_attempts: z.number().int().min(0),
    token_input: z.literal('unavailable'),
    token_output: z.literal('unavailable'),
    token_cache: z.literal('unavailable'),
    approved_tasks: z.number().int().min(0),
    blocking_findings: z.number().int().min(0),
    carry_forward_findings: z.number().int().min(0),
    durations_diagnostic: z.literal(true)
  })
  .strict()

export const MaestroRunProgressSummarySchema = z
  .object({
    schema_version: z.literal(1),
    state: RunProgressStateSchema,
    progress_percent: z.number().int().min(0).max(100),
    task_counts: z
      .object({
        approved: z.number().int().min(0),
        running: z.number().int().min(0),
        input_required: z.number().int().min(0),
        blocked: z.number().int().min(0),
        pending: z.number().int().min(0),
        failed: z.number().int().min(0)
      })
      .strict(),
    current_tasks: z.array(RunProgressTaskReferenceSchema).max(3),
    next_tasks: z.array(RunProgressTaskReferenceSchema).max(3),
    cleanup: z
      .object({
        pending: RunProgressCleanupGroupSchema,
        unverifiable: RunProgressCleanupGroupSchema,
        failed: RunProgressCleanupGroupSchema,
        retained: RunProgressCleanupGroupSchema
      })
      .strict(),
    last_activity: RunProgressActivitySchema.nullable(),
    blockers: z.array(RunProgressReferenceSchema).max(5),
    material_findings: z.array(RunProgressReferenceSchema).max(5),
    coordination: RunProgressCoordinationSchema.optional()
  })
  .strict()
  .superRefine((summary, context) => {
    const unresolvedCleanup = Object.values(summary.cleanup).some((group) => group.count > 0)
    const unresolvedTasks =
      summary.task_counts.running > 0 ||
      summary.task_counts.input_required > 0 ||
      summary.task_counts.blocked > 0 ||
      summary.task_counts.pending > 0 ||
      summary.task_counts.failed > 0
    const preventsCompletion =
      summary.material_findings.length > 0 || unresolvedCleanup || unresolvedTasks
    if (summary.state === 'complete' && (summary.progress_percent !== 100 || preventsCompletion)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Complete progress cannot include unresolved Harness state.'
      })
    }
    if (summary.state !== 'complete' && summary.progress_percent === 100) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only complete Harness progress may report 100 percent.'
      })
    }
  })

export const MaestroRunProgressV1Schema = MaestroRunProgressSummarySchema

export type MaestroRunProgressState = z.infer<typeof RunProgressStateSchema>
export type MaestroRunProgressReference = z.infer<typeof RunProgressReferenceSchema>
export type MaestroRunProgressTaskReference = z.infer<typeof RunProgressTaskReferenceSchema>
export type MaestroRunProgressCleanupGroup = z.infer<typeof RunProgressCleanupGroupSchema>
export type MaestroRunProgressCoordination = z.infer<typeof RunProgressCoordinationSchema>
export type MaestroRunProgressSummary = z.infer<typeof MaestroRunProgressSummarySchema>
export type MaestroRunProgressV1 = MaestroRunProgressSummary
export type MaestroRunProgressPayload = MaestroRunProgressV1 | MaestroRunProgressV2
export type { MaestroRunProgressV2 }

export type LegacyMaestroTaskProgress = {
  completed: number
  total: number
  percent?: number
  allSettled: boolean
  hasFailures: boolean
}

export function legacyMaestroTaskProgress(
  summary: MaestroRunProgressSummary
): LegacyMaestroTaskProgress {
  const counts = summary.task_counts
  const completed = counts.approved + counts.failed
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const allSettled = total > 0 && completed === total
  return {
    completed,
    total,
    ...(total > 0 ? { percent: allSettled ? 100 : Math.round((completed / total) * 100) } : {}),
    allSettled,
    hasFailures: counts.failed > 0
  }
}

export type MaestroRunProgressAuthority = {
  runId: string
  workspace: { executionHostId: string; workspaceKey: string }
  revision: number
}

export type MaestroRunProgressDetailIdentity = {
  authority: MaestroRunProgressAuthority
  reference: MaestroRunProgressReference
}

export type MaestroRunProgress =
  | { available: true; summary: MaestroRunProgressSummary; authority: MaestroRunProgressAuthority }
  | { available: false; state: 'outcome_unknown' }

export function maestroRunProgressNodeId(runId: string): string {
  return `${MAESTRO_RUN_PROGRESS_NODE_PREFIX}${runId}`
}

export function unavailableMaestroRunProgress(): MaestroRunProgress {
  return { available: false, state: 'outcome_unknown' }
}

export function parseNegotiatedMaestroRunProgress(
  value: unknown,
  negotiatedVersion: 1 | 2
): MaestroRunProgressPayload
export function parseNegotiatedMaestroRunProgress(
  value: unknown,
  authority: MaestroRunProgressAuthority | null
): MaestroRunProgress
export function parseNegotiatedMaestroRunProgress(
  value: unknown,
  negotiation: 1 | 2 | MaestroRunProgressAuthority | null
): MaestroRunProgressPayload | MaestroRunProgress {
  if (typeof negotiation === 'number') {
    return negotiation === 1
      ? MaestroRunProgressV1Schema.parse(value)
      : MaestroRunProgressV2Schema.parse(value)
  }
  if (negotiation === null) {
    return unavailableMaestroRunProgress()
  }
  const parsed = MaestroRunProgressSummarySchema.safeParse(value)
  return parsed.success
    ? { available: true, summary: parsed.data, authority: negotiation }
    : unavailableMaestroRunProgress()
}

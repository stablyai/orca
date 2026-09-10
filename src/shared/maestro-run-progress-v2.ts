import { z } from 'zod'
import { MaestroRunResourcesSchema } from './maestro-run-resource'
import { containsAgentGraphControlCharacter } from './workspace-scope'

export const MAESTRO_RUN_PROGRESS_LIST_LIMIT = 64
export const MAESTRO_RUN_PROGRESS_TEXT_MAX_LENGTH = 2_048

const BoundedReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => !containsAgentGraphControlCharacter(value),
    'Control characters are not allowed'
  )
const BoundedTextSchema = z.string().trim().min(1).max(MAESTRO_RUN_PROGRESS_TEXT_MAX_LENGTH)
const CountSchema = z.number().int().nonnegative()

const MaestroRunProgressCountsSchema = z
  .object({
    pending: CountSchema,
    running: CountSchema,
    input_required: CountSchema,
    blocked: CountSchema,
    succeeded: CountSchema,
    failed: CountSchema,
    cancelled: CountSchema
  })
  .strict()

const MaestroRunProgressExecutionSchema = z
  .object({
    state: z.enum([
      'active',
      'input_required',
      'blocked',
      'completed',
      'completed_with_failures',
      'cancelled',
      'outcome_unknown'
    ]),
    progress_percent: z.number().int().min(0).max(100).optional(),
    completed: CountSchema,
    total: CountSchema,
    counts: MaestroRunProgressCountsSchema
  })
  .strict()

const MaestroDeliverableProgressSchema = z
  .object({
    progress_percent: z.number().int().min(0).max(100).optional(),
    completed: CountSchema,
    total: CountSchema
  })
  .strict()
  .superRefine((progress, context) => {
    const expected =
      progress.total === 0 ? undefined : Math.round((progress.completed / progress.total) * 100)
    if (progress.completed > progress.total || progress.progress_percent !== expected) {
      addContractIssue(
        context,
        ['progress_percent'],
        'Deliverable percentage must equal terminal deliverables over total deliverables'
      )
    }
  })

const MaestroOperationalReliabilitySchema = z
  .object({
    successful: CountSchema,
    failed: CountSchema,
    superseded: CountSchema,
    unverifiable: CountSchema
  })
  .strict()

const MaestroProjectionHealthSchema = z
  .object({
    state: z.enum(['healthy', 'partial', 'stale', 'unavailable']),
    revision: z.number().int().nonnegative().nullable(),
    warning: BoundedTextSchema.optional()
  })
  .strict()
  .superRefine((health, context) => {
    if ((health.state === 'unavailable') !== (health.revision === null)) {
      addContractIssue(
        context,
        ['revision'],
        'Only unavailable projection health can omit its revision'
      )
    }
    if (health.state === 'healthy' && health.warning !== undefined) {
      addContractIssue(context, ['warning'], 'Healthy projection cannot carry a warning')
    }
  })

const MaestroCleanupHealthSchema = z
  .object({
    state: z.enum(['clean', 'pending', 'unverifiable', 'failed']),
    count: CountSchema,
    warning: BoundedTextSchema.optional()
  })
  .strict()
  .superRefine((health, context) => {
    if (health.state === 'clean' && (health.count !== 0 || health.warning !== undefined)) {
      addContractIssue(
        context,
        ['state'],
        'Clean cleanup health cannot contain pending resources or a warning'
      )
    }
    if (health.state !== 'clean' && health.count === 0) {
      addContractIssue(context, ['count'], 'Cleanup problems require a non-zero resource count')
    }
  })

const MaestroProgressReferenceBaseSchema = z
  .object({
    reference: BoundedReferenceSchema,
    title: BoundedTextSchema,
    worker_label: BoundedTextSchema.optional()
  })
  .strict()

const MaestroCurrentProgressSchema = MaestroProgressReferenceBaseSchema.extend({
  state: z.enum(['pending', 'running', 'input_required', 'blocked']),
  activity_summary: BoundedTextSchema
}).strict()

const MaestroCompletedProgressSchema = MaestroProgressReferenceBaseSchema.extend({
  outcome_summary: BoundedTextSchema,
  purpose: z.enum(['deliverable', 'operational']).optional(),
  operational_outcome: z.enum(['successful', 'failed', 'superseded', 'unverifiable']).optional(),
  successor_reference: BoundedReferenceSchema.optional()
})
  .strict()
  .superRefine((entry, context) => {
    if (entry.operational_outcome && entry.purpose !== 'operational') {
      addContractIssue(
        context,
        ['operational_outcome'],
        'Operational outcomes require explicit operational purpose'
      )
    }
    if ((entry.operational_outcome === 'superseded') !== Boolean(entry.successor_reference)) {
      addContractIssue(
        context,
        ['successor_reference'],
        'Only a superseded operational outcome carries a successor reference'
      )
    }
  })

const MaestroNextProgressSchema = MaestroProgressReferenceBaseSchema.extend({
  next_step: BoundedTextSchema
}).strict()

const MaestroBlockedProgressSchema = MaestroProgressReferenceBaseSchema.extend({
  blocker_summary: BoundedTextSchema
}).strict()

const MaestroNestedProgressSchema = z
  .object({
    parent_reference: BoundedReferenceSchema,
    child_id: BoundedReferenceSchema,
    label: BoundedTextSchema,
    model: BoundedTextSchema.optional(),
    state: z.enum(['starting', 'running', 'waiting', 'completed', 'failed', 'cancelled']),
    activity_summary: BoundedTextSchema.optional()
  })
  .strict()

const MaestroRunCompletionSchema = z
  .object({
    state: z.literal('completed'),
    summary: BoundedTextSchema,
    evidence: z.array(BoundedTextSchema).min(1).max(MAESTRO_RUN_PROGRESS_LIST_LIMIT),
    waivers: z
      .array(z.object({ task_id: BoundedReferenceSchema, reason: BoundedTextSchema }).strict())
      .max(MAESTRO_RUN_PROGRESS_LIST_LIMIT),
    completed_at: z.iso.datetime(),
    completed_by: z
      .object({ handle: BoundedReferenceSchema, generation: z.number().int().nonnegative() })
      .strict()
  })
  .strict()

export const MaestroRunProgressV2Schema = z
  .object({
    schema_version: z.literal(2),
    run: z.object({ id: BoundedReferenceSchema, title: BoundedTextSchema }).strict(),
    execution: MaestroRunProgressExecutionSchema,
    deliverables: MaestroDeliverableProgressSchema.optional(),
    operational_reliability: MaestroOperationalReliabilitySchema.optional(),
    projection_health: MaestroProjectionHealthSchema,
    cleanup_health: MaestroCleanupHealthSchema,
    current: z.array(MaestroCurrentProgressSchema).max(MAESTRO_RUN_PROGRESS_LIST_LIMIT),
    recently_completed: z
      .array(MaestroCompletedProgressSchema)
      .max(MAESTRO_RUN_PROGRESS_LIST_LIMIT),
    next: z.array(MaestroNextProgressSchema).max(MAESTRO_RUN_PROGRESS_LIST_LIMIT),
    blocked: z.array(MaestroBlockedProgressSchema).max(MAESTRO_RUN_PROGRESS_LIST_LIMIT),
    nested_activity: z.array(MaestroNestedProgressSchema).max(MAESTRO_RUN_PROGRESS_LIST_LIMIT),
    completion: MaestroRunCompletionSchema.optional(),
    resources: MaestroRunResourcesSchema.optional(),
    technical: z
      .object({
        execution_host_id: BoundedReferenceSchema,
        workspace_key: BoundedReferenceSchema,
        run_id: BoundedReferenceSchema,
        revision: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()
  .superRefine((progress, context) => {
    validateExecutionProgress(progress.execution, context)
    if (progress.run.id !== progress.technical.run_id) {
      addContractIssue(
        context,
        ['technical', 'run_id'],
        'Technical run identity must match the displayed Run'
      )
    }
  })

export type MaestroRunProgressV2 = z.infer<typeof MaestroRunProgressV2Schema>

function validateExecutionProgress(
  execution: z.infer<typeof MaestroRunProgressExecutionSchema>,
  context: z.RefinementCtx
): void {
  const counts = execution.counts
  const completed = counts.succeeded + counts.failed + counts.cancelled
  const total = completed + counts.pending + counts.running + counts.input_required + counts.blocked
  const expectedProgress = total === 0 ? undefined : Math.round((completed / total) * 100)
  const terminalState = ['completed', 'completed_with_failures', 'cancelled'].includes(
    execution.state
  )

  if (execution.completed !== completed || execution.total !== total) {
    addExecutionIssue(
      context,
      'counts',
      'Execution totals must be derived from Task lifecycle counts'
    )
  }
  if (execution.progress_percent !== expectedProgress) {
    addExecutionIssue(
      context,
      'progress_percent',
      'Execution percentage must equal terminal Tasks over total Tasks'
    )
  }
  if (terminalState !== (total > 0 && completed === total)) {
    addExecutionIssue(
      context,
      'state',
      'Terminal execution state must agree with terminal Task counts'
    )
  }
  if (execution.state === 'completed' && (counts.failed !== 0 || counts.cancelled !== 0)) {
    addExecutionIssue(
      context,
      'state',
      'Completed execution cannot contain failed or cancelled Tasks'
    )
  }
  if (execution.state === 'completed_with_failures' && counts.failed === 0) {
    addExecutionIssue(context, 'state', 'Completed-with-failures execution requires a failed Task')
  }
  if (execution.state === 'cancelled' && counts.cancelled === 0) {
    addExecutionIssue(context, 'state', 'Cancelled execution requires a cancelled Task')
  }
}

function addContractIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message })
}

function addExecutionIssue(context: z.RefinementCtx, field: string, message: string): void {
  addContractIssue(context, ['execution', field], message)
}

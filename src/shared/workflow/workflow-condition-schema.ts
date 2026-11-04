import { z } from 'zod'

/** Dot path into a worker's structured result; no brackets or expressions, so it can never execute. */
export const WORKFLOW_FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/

export const WORKFLOW_FIELD_OPERATORS = [
  'equals',
  'not-equals',
  'contains',
  'exists',
  'not-exists',
  'gt',
  'lt'
] as const

export type WorkflowFieldOperator = (typeof WORKFLOW_FIELD_OPERATORS)[number]

export type WorkflowCondition =
  | { kind: 'always' }
  | { kind: 'outcome'; equals: 'succeeded' | 'failed' }
  | { kind: 'approval'; equals: 'approved' | 'rejected' }
  | {
      kind: 'field'
      path: string
      op: WorkflowFieldOperator
      value?: string | number | boolean
    }
  | { kind: 'all'; conditions: WorkflowCondition[] }
  | { kind: 'any'; conditions: WorkflowCondition[] }
  | { kind: 'not'; condition: WorkflowCondition }

const ConditionValue = z.union([z.string().max(512), z.number(), z.boolean()])

// Why: a declarative tree keeps conditions data, never code; depth is bounded by the recursion cap below.
export const WorkflowConditionSchema: z.ZodType<WorkflowCondition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('always') }),
    z.object({ kind: z.literal('outcome'), equals: z.enum(['succeeded', 'failed']) }),
    z.object({ kind: z.literal('approval'), equals: z.enum(['approved', 'rejected']) }),
    z.object({
      kind: z.literal('field'),
      path: z.string().regex(WORKFLOW_FIELD_PATH_PATTERN, 'Use a dot path such as verdict'),
      op: z.enum(WORKFLOW_FIELD_OPERATORS),
      value: ConditionValue.optional()
    }),
    z.object({ kind: z.literal('all'), conditions: z.array(WorkflowConditionSchema).max(16) }),
    z.object({ kind: z.literal('any'), conditions: z.array(WorkflowConditionSchema).max(16) }),
    z.object({ kind: z.literal('not'), condition: WorkflowConditionSchema })
  ])
)

export const WORKFLOW_CONDITION_MAX_DEPTH = 6

export function workflowConditionDepth(condition: WorkflowCondition): number {
  switch (condition.kind) {
    case 'all':
    case 'any':
      return 1 + Math.max(0, ...condition.conditions.map(workflowConditionDepth))
    case 'not':
      return 1 + workflowConditionDepth(condition.condition)
    case 'always':
    case 'outcome':
    case 'approval':
    case 'field':
      return 1
  }
}

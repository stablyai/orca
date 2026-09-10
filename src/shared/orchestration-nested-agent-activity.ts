import { z } from 'zod'
import { containsAgentGraphControlCharacter } from './workspace-scope'

export const NESTED_AGENT_ACTIVITY_LIMIT = 128
export const NESTED_AGENT_ACTIVITY_SUMMARY_MAX_LENGTH = 2_048

const NestedAgentIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => !containsAgentGraphControlCharacter(value),
    'Control characters are not allowed'
  )

const NestedAgentSummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(NESTED_AGENT_ACTIVITY_SUMMARY_MAX_LENGTH)

const NestedAgentActivityBaseSchema = z
  .object({
    parent_dispatch_id: NestedAgentIdentitySchema,
    parent_provider_session_id: NestedAgentIdentitySchema,
    provider_child_id: NestedAgentIdentitySchema,
    provider: NestedAgentIdentitySchema,
    type: NestedAgentIdentitySchema,
    model: NestedAgentIdentitySchema.optional(),
    description: NestedAgentSummarySchema,
    started_at: z.iso.datetime(),
    updated_at: z.iso.datetime()
  })
  .strict()

export const OrchestrationNestedAgentActivitySchema = z
  .union([
    NestedAgentActivityBaseSchema.extend({
      state: z.enum(['starting', 'running', 'waiting']),
      completed_at: z.never().optional()
    }).strict(),
    NestedAgentActivityBaseSchema.extend({
      state: z.enum(['completed', 'failed', 'cancelled']),
      completed_at: z.iso.datetime()
    }).strict()
  ])
  .superRefine((activity, context) => {
    const startedAt = Date.parse(activity.started_at)
    const updatedAt = Date.parse(activity.updated_at)
    if (updatedAt < startedAt) {
      context.addIssue({
        code: 'custom',
        path: ['updated_at'],
        message: 'Updated time cannot precede the start time'
      })
    }
    if (activity.completed_at !== undefined && Date.parse(activity.completed_at) < updatedAt) {
      context.addIssue({
        code: 'custom',
        path: ['completed_at'],
        message: 'Completed time cannot precede the latest update'
      })
    }
  })

export const OrchestrationNestedAgentActivityListSchema = z
  .array(OrchestrationNestedAgentActivitySchema)
  .max(NESTED_AGENT_ACTIVITY_LIMIT)
  .superRefine((activities, context) => {
    const childIds = new Set<string>()
    for (const [index, activity] of activities.entries()) {
      const identity = `${activity.parent_dispatch_id}\u0000${activity.provider_child_id}`
      if (childIds.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'provider_child_id'],
          message: 'Nested child identity must be unique within its parent Dispatch'
        })
      }
      childIds.add(identity)
    }
  })

export type OrchestrationNestedAgentActivity = z.infer<
  typeof OrchestrationNestedAgentActivitySchema
>

export function parseOrchestrationNestedAgentActivities(
  value: unknown
): OrchestrationNestedAgentActivity[] {
  return OrchestrationNestedAgentActivityListSchema.parse(value)
}

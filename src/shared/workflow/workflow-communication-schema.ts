import { z } from 'zod'

const EdgeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, - or _')

export const WORKFLOW_MESSAGE_TYPES = [
  'task-assignment',
  'status-update',
  'question',
  'reply',
  'artifact',
  'completion',
  'failure',
  'review-feedback',
  'control'
] as const
export type WorkflowMessageType = (typeof WORKFLOW_MESSAGE_TYPES)[number]

export const WORKFLOW_PAYLOAD_KINDS = [
  'task-spec',
  'structured-json',
  'summary',
  'selected-fields',
  'git-diff-ref',
  'artifact-refs',
  'test-summary',
  'selected-context',
  'full-transcript'
] as const
export type WorkflowPayloadKind = (typeof WORKFLOW_PAYLOAD_KINDS)[number]

export const WorkflowPayloadPolicySchema = z.object({
  kind: z.enum(WORKFLOW_PAYLOAD_KINDS),
  /** selected-fields: top-level keys copied from the sender's structured result. */
  fields: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(32),
  /** selected-context: the exact text the user chose to send; nothing else is added. */
  context: z.string().max(20_000),
  /** full-transcript needs this second switch; Orca still sends only the report it holds. */
  transcriptExplicitlyEnabled: z.boolean()
})
export type WorkflowPayloadPolicy = z.infer<typeof WorkflowPayloadPolicySchema>

export const WORKFLOW_BUDGET_ACTIONS = [
  'reject',
  'truncate',
  'request-shorter',
  'escalate',
  'fail-task'
] as const
export type WorkflowBudgetAction = (typeof WORKFLOW_BUDGET_ACTIONS)[number]

export const WorkflowCommunicationPolicySchema = z.object({
  allowedMessageTypes: z.array(z.enum(WORKFLOW_MESSAGE_TYPES)).min(1),
  payload: WorkflowPayloadPolicySchema,
  maxMessageBytes: z.number().int().min(64).max(5_000_000),
  maxMessagesPerRun: z.number().int().min(1).max(10_000),
  rateLimitPerMinute: z.number().int().min(1).max(600).nullable(),
  /** Top-level keys a structured payload must carry before delivery. */
  requiredPayloadFields: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(32),
  onBudgetExhausted: z.enum(WORKFLOW_BUDGET_ACTIONS),
  requiresApproval: z.boolean(),
  logging: z.enum(['full', 'metadata'])
})
export type WorkflowCommunicationPolicy = z.infer<typeof WorkflowCommunicationPolicySchema>

export const WorkflowCommunicationEdgeSchema = z.object({
  id: EdgeId,
  source: EdgeId,
  target: EdgeId,
  name: z.string().max(80),
  enabled: z.boolean(),
  policy: WorkflowCommunicationPolicySchema
})
export type WorkflowCommunicationEdge = z.infer<typeof WorkflowCommunicationEdgeSchema>

export function defaultWorkflowCommunicationPolicy(
  payload: WorkflowPayloadPolicy['kind'] = 'summary'
): WorkflowCommunicationPolicy {
  return {
    allowedMessageTypes: ['task-assignment', 'completion', 'artifact', 'review-feedback'],
    payload: { kind: payload, fields: [], context: '', transcriptExplicitlyEnabled: false },
    maxMessageBytes: 64_000,
    maxMessagesPerRun: 50,
    rateLimitPerMinute: null,
    requiredPayloadFields: [],
    onBudgetExhausted: 'reject',
    requiresApproval: false,
    logging: 'full'
  }
}

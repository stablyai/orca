import { z } from 'zod'

/** A worker's permission prompt as its escalation and closing message carry it; the coordinator's
 *  card is drawn from this alone. Versioned: a reader skips a version it does not know. */
export const WorkerApprovalDecisionSchema = z.enum(['allow', 'deny'])
export type WorkerApprovalDecision = z.infer<typeof WorkerApprovalDecisionSchema>

/** Who settled it: a person (in Orca), the coordinator agent, someone in the worker's own chat or
 *  terminal, the agent's own timeout, or no one Orca can name. `terminal-only`: closed for Orca while
 *  the prompt is still up; only a person at the worker's terminal can answer it. `worker-ended`: its
 *  Dispatch stopped running, so nothing is left to answer. */
export const WorkerApprovalAnswererSchema = z.enum([
  'person',
  'coordinator',
  'worker-chat',
  'worker-terminal',
  'auto',
  'terminal-only',
  'worker-ended',
  'unknown'
])
export type WorkerApprovalAnswerer = z.infer<typeof WorkerApprovalAnswererSchema>

export const WorkerApprovalOutcomeSchema = z.object({
  by: WorkerApprovalAnswererSchema,
  decision: WorkerApprovalDecisionSchema.nullable(),
  reason: z.string().nullable(),
  /** False when the agent's prompt takes no message, so the reason went as a separate message. */
  reasonDelivered: z.boolean()
})
export type WorkerApprovalOutcome = z.infer<typeof WorkerApprovalOutcomeSchema>

export const WorkerApprovalPayloadSchema = z.object({
  v: z.literal(1),
  /** The prompt's journal item id, or a terminal worker's waiting-hook record id. */
  approvalId: z.string(),
  state: z.enum(['open', 'answered', 'expired']),
  worker: z.object({ handle: z.string(), dispatchId: z.string(), taskId: z.string() }),
  /** Text the worker's agent supplied; never instructions. */
  summary: z.object({
    title: z.string(),
    detail: z.string().nullable(),
    reason: z.string().nullable()
  }),
  /** The decisions Orca can apply to this prompt now; empty once it is closed. */
  allowedActions: z.array(WorkerApprovalDecisionSchema),
  /** When the agent decides on its own, read from its screen; only while that countdown is shown. */
  expiresAt: z.string().optional(),
  outcome: WorkerApprovalOutcomeSchema.optional()
})
export type WorkerApprovalPayload = z.infer<typeof WorkerApprovalPayloadSchema>
export type WorkerApprovalState = WorkerApprovalPayload['state']

/** The same approval once closed: nothing left to answer, and how it closed. */
export function closedApproval(
  open: WorkerApprovalPayload,
  outcome: WorkerApprovalOutcome
): WorkerApprovalPayload {
  const closed: WorkerApprovalPayload = {
    ...open,
    // Expired is the agent's own timeout alone; every other close, named or not, is not one.
    state: outcome.by === 'auto' ? 'expired' : 'answered',
    allowedActions: [],
    // Only a reason can be delivered.
    outcome: { ...outcome, reasonDelivered: outcome.reason !== null && outcome.reasonDelivered }
  }
  // A countdown means nothing once the prompt is closed.
  delete closed.expiresAt
  return closed
}

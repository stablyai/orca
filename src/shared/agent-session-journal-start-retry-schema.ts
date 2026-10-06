import { z } from 'zod'
import { AgentSessionFailureFactSchema } from './agent-session-failure-fact-schema'

/** A queued message's failed start: see `AgentJournalStartRetry`. */
export const AgentJournalStartRetrySchema = z.object({
  attempts: z.number().int().positive(),
  reason: z.string(),
  rejection: AgentSessionFailureFactSchema,
  failedAt: z.number(),
  nextAttemptAt: z.number()
})

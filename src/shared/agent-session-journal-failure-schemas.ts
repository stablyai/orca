// The failure facts a journal row or submission carries, as a reader admits them.

import { z } from 'zod'

/** Open like `state`: a kind, audience or refusal detail a newer host writes must not turn the row
 *  malformed; the fact reader is where an unplaceable one is dropped. */
export const FailureFact = z.object({
  kind: z.string().min(1),
  detail: z.object({ text: z.string(), audience: z.string().min(1) }).optional(),
  refusal: z.object({ code: z.string().min(1), details: z.looseObject({}).optional() }).optional()
})

/** A queued message's failed start: see `AgentJournalStartRetry`. */
export const AgentJournalStartRetrySchema = z.object({
  attempts: z.number().int().positive(),
  reason: z.string(),
  rejection: FailureFact,
  failedAt: z.number(),
  nextAttemptAt: z.number()
})

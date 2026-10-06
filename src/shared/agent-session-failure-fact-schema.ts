import { z } from 'zod'

/** A failure fact as a journal row carries it. Open like a row's `state`: a kind, audience or
 *  refusal detail a newer host writes must not turn the row malformed; the fact reader is where an
 *  unplaceable one is dropped. */
export const AgentSessionFailureFactSchema = z.object({
  kind: z.string().min(1),
  detail: z.object({ text: z.string(), audience: z.string().min(1) }).optional(),
  refusal: z.object({ code: z.string().min(1), details: z.looseObject({}).optional() }).optional()
})

import { z } from 'zod'

/** Keep newer kinds/audiences/refusal details readable like row state; the fact reader drops anything it cannot place. */
export const AgentSessionFailureFactSchema = z.object({
  kind: z.string().min(1),
  detail: z.object({ text: z.string(), audience: z.string().min(1) }).optional(),
  refusal: z.object({ code: z.string().min(1), details: z.looseObject({}).optional() }).optional(),
  argumentProblem: z
    .object({ agent: z.string(), option: z.string(), problem: z.string() })
    .optional(),
  requestTimeout: z.looseObject({}).optional()
})

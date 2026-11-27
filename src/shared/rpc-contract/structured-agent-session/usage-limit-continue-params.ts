import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const CancelUsageLimitContinueParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: z.string().min(1),
      turnItemId: z.string().min(1),
      resetsAt: z.number().finite()
    })
    .strict()
)

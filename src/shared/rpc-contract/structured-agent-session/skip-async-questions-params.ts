import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const SkipAsyncQuestionsParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: z.string().min(1),
      /** The newest question row the card showed; it and every earlier question are skipped. */
      itemId: z.string().min(1).max(512)
    })
    .strict()
)

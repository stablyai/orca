import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const OptionalNativeChatSignIn = lazyZodSchema(() =>
  z
    .object({
      agent: z.string().min(1).max(128),
      account: z.enum(['system', 'managed']).optional(),
      remote: z.boolean()
    })
    .optional()
)

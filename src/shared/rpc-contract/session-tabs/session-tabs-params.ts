import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const SessionTabsUnsubscribeAllParams = lazyZodSchema(() =>
  z
    .object({
      subscriptionId: z.string().min(1).optional()
    })
    .nullish()
)

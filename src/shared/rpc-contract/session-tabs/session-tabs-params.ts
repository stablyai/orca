import { z } from 'zod'

export const SessionTabsUnsubscribeAllParams = z
  .object({
    subscriptionId: z.string().min(1).optional()
  })
  .nullish()

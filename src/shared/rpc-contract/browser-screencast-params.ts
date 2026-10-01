import { z } from 'zod'

export const ScreencastUnsubscribe = z.object({
  subscriptionId: z.string().min(1, 'Missing required --subscription-id')
})

import { z } from 'zod'

export const ScreencastUnsubscribe = z.object({
  subscriptionId: z.string().min(1, 'Missing required --subscription-id')
})

export const ScreencastAck = z.object({
  subscriptionId: z.string().min(1),
  seq: z.number().int().nonnegative()
})

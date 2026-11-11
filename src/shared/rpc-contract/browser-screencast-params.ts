import { z } from 'zod'

export const ScreencastUnsubscribe = z.object({
  subscriptionId: z.string().min(1, 'Missing required --subscription-id')
})

export const ScreencastAck = z.object({
  subscriptionId: z.string().min(1, 'Missing required --subscription-id'),
  // Cumulative: the newest frame seq the viewer has received.
  seq: z.number().int().nonnegative()
})

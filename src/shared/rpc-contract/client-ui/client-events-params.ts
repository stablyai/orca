import { z } from 'zod'

export const ClientEventsSubscribeParams = z.object({
  // Only the desktop renderer opts in; main-process relays on the same socket cannot answer host requests.
  browserHostRequests: z.boolean().optional()
})

export const ClientEventsUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

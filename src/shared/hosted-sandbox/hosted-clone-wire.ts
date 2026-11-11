import { z } from 'zod'

/** GET /v1/sandboxes/:id/clone: the background clone of a `clone-progress` create. */
export const HostedCloneStatusResponseSchema = z.object({
  clone: z.discriminatedUnion('state', [
    z.object({ state: z.literal('none') }),
    z.object({
      state: z.literal('running'),
      percent: z.number().int().min(0).max(100),
      stage: z.enum(['download', 'checkout'])
    }),
    z.object({ state: z.literal('done') }),
    // Open: a newer control plane may add reasons.
    z.object({ state: z.literal('failed'), reason: z.string().max(64) })
  ])
})
export type HostedCloneStatus = z.infer<typeof HostedCloneStatusResponseSchema>['clone']

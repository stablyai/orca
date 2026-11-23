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

const LegacyJournalRetirementClaimAddress = z.strictObject({
  subscriptionId: z.string().min(1).max(256),
  token: z.uuid()
})

export const LegacyJournalRetirementClaimParams = LegacyJournalRetirementClaimAddress.extend({
  release: z.literal(true).optional()
})

export const LegacyJournalRetirementAckParams = z.discriminatedUnion('accepted', [
  LegacyJournalRetirementClaimAddress.extend({ accepted: z.literal(false) }),
  LegacyJournalRetirementClaimAddress.extend({ accepted: z.literal(true), deliveryId: z.uuid() })
])

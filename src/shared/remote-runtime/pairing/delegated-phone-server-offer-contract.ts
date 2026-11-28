import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { MobilePairingConnectionMode } from './mobile-pairing-connection-mode'

// Why: a phone relayed by a desktop asks the server for a pairing of its own, so it keeps
// reaching that server while the desktop sleeps. Only a delegated phone row may ask.
export const DELEGATED_PHONE_SERVER_OFFER_METHOD = 'pairing.delegatedMobileDevice.createOffer'
// Hosts without this refuse the method; the phone offers the action only on servers advertising it.
export const DELEGATED_PHONE_SERVER_OFFER_RUNTIME_CAPABILITY =
  'pairing.delegated-phone-server-offers.v1' as const

export const DelegatedPhoneServerOfferParamsSchema = lazyZodSchema(() =>
  z
    .object({
      // Stamped by the relaying desktop from the phone's own pairing there; absent means LAN only.
      connectionMode: z.enum(['automatic', 'local-only']).optional()
    })
    .strict()
)

export type DelegatedPhoneServerOfferParams = z.infer<typeof DelegatedPhoneServerOfferParamsSchema>

export type DelegatedPhoneServerOfferResult =
  | {
      available: true
      pairingUrl: string
      /** The offer's own row, which pairing the phone signs in as. */
      deviceId: string
      connectionMode: MobilePairingConnectionMode
    }
  | { available: false; reason: string; guidance: string }

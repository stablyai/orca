import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { MobilePairingConnectionMode } from './mobile-pairing-connection-mode'

export const PAIRING_CREATE_OFFER_METHOD = 'pairing.createOffer'

export const PairingCreateOfferParamsSchema = lazyZodSchema(() =>
  z
    .object({
      scope: z.enum(['mobile', 'runtime']),
      address: z.string().min(1).max(512).optional(),
      relay: z.boolean().optional(),
      grantDesktopControl: z.boolean().optional(),
      rotate: z.boolean().optional(),
      /** The terminal `orca pair` ran in; one a paired client opened tags the offer with that client. */
      callerTerminalHandle: z.string().min(1).max(256).optional()
    })
    .strict()
    .refine((params) => params.scope === 'mobile' || params.relay !== true, {
      message: 'relay applies only to mobile pairing'
    })
    .refine((params) => params.scope === 'runtime' || params.grantDesktopControl !== true, {
      message: 'desktop control can be granted only to a runtime client'
    })
)

export type PairingCreateOfferParams = z.infer<typeof PairingCreateOfferParamsSchema>

export type PairingCreateOfferResult =
  | {
      available: true
      scope: 'mobile' | 'runtime'
      pairingUrl: string
      /** Null when only Relay can reach this host. */
      endpoint: string | null
      deviceId: string
      webClientUrl: string | null
      connectionMode: MobilePairingConnectionMode | null
      /** Terminal QR text for mobile offers; runtime clients paste the URL. */
      qr: string | null
    }
  | { available: false; reason: string; guidance: string }

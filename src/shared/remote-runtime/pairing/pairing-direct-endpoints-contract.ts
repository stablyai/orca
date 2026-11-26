import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { PAIRING_ENDPOINT_MAX_CHARACTERS } from './mobile-pairing-protocol-limits'

// Older hosts refuse this method (forbidden or method_not_found); phones then keep their pairing-time endpoint.
export const PAIRING_GET_DIRECT_ENDPOINTS_METHOD = 'pairing.getDirectEndpoints' as const

export const PairingGetDirectEndpointsParamsSchema = lazyZodSchema(() => z.object({}).strict())

// Not strict: later hosts may add fields without breaking shipped phones.
export const PairingGetDirectEndpointsResultSchema = lazyZodSchema(() =>
  z.object({
    v: z.literal(1),
    // Every direct endpoint the host's listener answers on now, in QR preference order; empty when not network-exposed.
    endpoints: z.array(z.string().min(1).max(PAIRING_ENDPOINT_MAX_CHARACTERS)).max(64)
  })
)

export type PairingGetDirectEndpointsResult = z.infer<typeof PairingGetDirectEndpointsResultSchema>

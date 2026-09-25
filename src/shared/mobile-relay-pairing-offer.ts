import { z } from 'zod'
import {
  PAIRING_DEVICE_TOKEN_MAX_CHARACTERS,
  PAIRING_ENDPOINT_MAX_CHARACTERS,
  PAIRING_PUBLIC_KEY_MAX_CHARACTERS,
  PAIRING_RELAY_URL_MAX_CHARACTERS,
  PAIRING_TUNNEL_TOKEN_MAX_CHARACTERS
} from './mobile-pairing-protocol-limits'

export const PAIRING_OFFER_VERSION = 2
// Why: a tunnel offer must fail closed on clients that predate tunnels; they accept only v2 and
// would otherwise strip the tunnel and dial the fallback address.
export const PAIRING_OFFER_TUNNEL_VERSION = 3
const PairingScopeSchema = z.enum(['mobile', 'runtime'])
const BASE64URL_16_PATTERN = /^[A-Za-z0-9_-]{16}$/
const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
// Why: tailcat prints its address blob as `tc` + base64url; anything else is not a dialable server.
const TAILCAT_ADDRESS_BLOB_PATTERN = /^tc[A-Za-z0-9_-]+$/
const MAX_INVITE_TTL_MS = 10 * 60 * 1000
// The cell stamps expiry from its own clock; without leeway, a cell clock
// even slightly ahead of this machine makes every invite fail validation
// (same class as the host-proof freshness incident).
const INVITE_EXPIRY_CLOCK_SKEW_MS = 30 * 1000

function isCanonicalHttpsOrigin(value: string): boolean {
  if (
    value.length > PAIRING_RELAY_URL_MAX_CHARACTERS ||
    new TextEncoder().encode(value).length > PAIRING_RELAY_URL_MAX_CHARACTERS
  ) {
    return false
  }
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && value === parsed.origin
  } catch {
    return false
  }
}

function isCanonicalBase64Key(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return false
  }
  try {
    const decoded = atob(value)
    return decoded.length === 32 && btoa(decoded) === value
  } catch {
    return false
  }
}

// Why: the blob pins the host's WireGuard key and relay but carries no port, so the WS port rides beside it.
export const PairingTunnelSchema = z.object({
  v: z.literal(1),
  kind: z.literal('tailcat'),
  token: z
    .string()
    .min(3)
    .max(PAIRING_TUNNEL_TOKEN_MAX_CHARACTERS)
    .regex(TAILCAT_ADDRESS_BLOB_PATTERN, 'Expected a tailcat address blob'),
  port: z.number().int().min(1).max(65535)
})

export type PairingTunnel = z.infer<typeof PairingTunnelSchema>

export function createPairingOfferSchema(now: () => number = () => Date.now()) {
  const relaySchema = z.object({
    v: z.literal(1),
    directorUrl: z
      .string()
      .min(1)
      .refine(isCanonicalHttpsOrigin, 'Expected canonical HTTPS origin'),
    cellUrl: z.string().min(1).refine(isCanonicalHttpsOrigin, 'Expected canonical HTTPS origin'),
    assignmentEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    relayHostId: z.string().regex(BASE64URL_16_PATTERN),
    inviteToken: z.string().regex(BASE64URL_43_PATTERN),
    inviteExpiresAt: z
      .number()
      .int()
      .refine((value) => {
        const currentTime = now()
        return (
          value > currentTime &&
          value <= currentTime + MAX_INVITE_TTL_MS + INVITE_EXPIRY_CLOCK_SKEW_MS
        )
      }, 'Expected a future invite expiry no more than 10 minutes away'),
    e2eeFraming: z.literal(2)
  })

  return z
    .object({
      v: z.union([z.literal(PAIRING_OFFER_VERSION), z.literal(PAIRING_OFFER_TUNNEL_VERSION)]),
      endpoint: z.string().min(1).max(PAIRING_ENDPOINT_MAX_CHARACTERS),
      deviceToken: z.string().min(1).max(PAIRING_DEVICE_TOKEN_MAX_CHARACTERS),
      // Why: the desktop's Curve25519 public key is pinned by the pairing
      // offer, while relayHostId is verified from its decoded bytes later.
      publicKeyB64: z.string().min(1).max(PAIRING_PUBLIC_KEY_MAX_CHARACTERS),
      pairedDeviceId: z.string().min(1).max(128).optional(),
      scope: PairingScopeSchema.optional(),
      relay: relaySchema.optional(),
      // Why: unlike relay, a tunnel is valid for both scopes — a desktop client dials it the same way a phone would.
      tunnel: PairingTunnelSchema.optional()
    })
    .superRefine((offer, ctx) => {
      if ((offer.v === PAIRING_OFFER_TUNNEL_VERSION) !== (offer.tunnel !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tunnel'],
          message: `Tunnel offers use pairing version ${PAIRING_OFFER_TUNNEL_VERSION} and only they do`
        })
      }
      if (offer.relay && offer.scope === 'runtime') {
        // Why: relay v1 is mobile-only; accepting it on runtime offers would
        // imply routing and credential support that client does not have.
        ctx.addIssue({
          code: 'custom',
          path: ['relay'],
          message: 'Relay is invalid for runtime scope'
        })
      }
      if (offer.relay && !isCanonicalBase64Key(offer.publicKeyB64)) {
        // Why: relayHostId is derived from the decoded key bytes, so relay
        // offers cannot tolerate the permissive legacy base64 aliases.
        ctx.addIssue({
          code: 'custom',
          path: ['publicKeyB64'],
          message: 'Relay offers require a canonical 32-byte public key'
        })
      }
    })
}

export const PairingOfferSchema = createPairingOfferSchema()
export type PairingOffer = z.infer<typeof PairingOfferSchema>
export type PairingRelay = NonNullable<PairingOffer['relay']>

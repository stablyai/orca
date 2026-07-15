import { z } from 'zod'

export const PAIRING_OFFER_VERSION = 2
const PairingScopeSchema = z.enum(['mobile', 'runtime'])
const BASE64URL_16_PATTERN = /^[A-Za-z0-9_-]{16}$/
const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_RELAY_URL_BYTES = 2048
const MAX_INVITE_TTL_MS = 10 * 60 * 1000

function isCanonicalHttpsOrigin(value: string): boolean {
  if (new TextEncoder().encode(value).length > MAX_RELAY_URL_BYTES) {
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
        return value > currentTime && value <= currentTime + MAX_INVITE_TTL_MS
      }, 'Expected a future invite expiry no more than 10 minutes away'),
    e2eeFraming: z.literal(2)
  })

  return z
    .object({
      v: z.literal(PAIRING_OFFER_VERSION),
      endpoint: z.string().min(1),
      deviceToken: z.string().min(1),
      // Why: the desktop's Curve25519 public key is pinned by the pairing
      // offer, while relayHostId is verified from its decoded bytes later.
      publicKeyB64: z.string().min(1),
      scope: PairingScopeSchema.optional(),
      relay: relaySchema.optional()
    })
    .superRefine((offer, ctx) => {
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

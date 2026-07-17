import { z } from 'zod'
import {
  PAIRING_DEVICE_TOKEN_MAX_CHARACTERS,
  PAIRING_ENDPOINT_MAX_CHARACTERS,
  PAIRING_PUBLIC_KEY_MAX_CHARACTERS,
  PAIRING_RELAY_URL_MAX_CHARACTERS
} from './mobile-pairing-protocol-limits'

export const PAIRING_OFFER_VERSION = 2
// Why: QR payloads grow with each endpoint; ECC M / 256px stays scannable at a
// small ordered list (Tailscale + LAN + a couple customs).
export const MAX_PAIRING_ENDPOINTS = 4
export const MAX_PAIRING_ENDPOINT_BYTES = 320
// Why: a 256px QR becomes unreliable when an otherwise valid collection of
// long hostnames pushes the encoded offer into very dense QR versions.
export const MAX_PAIRING_OFFER_JSON_BYTES = 900
const PairingScopeSchema = z.enum(['mobile', 'runtime'])
const BASE64URL_16_PATTERN = /^[A-Za-z0-9_-]{16}$/
const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_INVITE_TTL_MS = 10 * 60 * 1000

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
      endpoint: z
        .string()
        .min(1)
        .max(Math.min(MAX_PAIRING_ENDPOINT_BYTES, PAIRING_ENDPOINT_MAX_CHARACTERS)),
      // Why: additive ordered failover list for new mobile clients. Old apps ignore
      // unknown fields / only read `endpoint`, so keep `endpoint` as the primary.
      endpoints: z
        .array(
          z
            .string()
            .min(1)
            .max(Math.min(MAX_PAIRING_ENDPOINT_BYTES, PAIRING_ENDPOINT_MAX_CHARACTERS))
        )
        .min(1)
        .max(MAX_PAIRING_ENDPOINTS)
        .optional(),
      deviceToken: z.string().min(1).max(PAIRING_DEVICE_TOKEN_MAX_CHARACTERS),
      // Why: the desktop's Curve25519 public key is pinned by the pairing
      // offer, while relayHostId is verified from its decoded bytes later.
      publicKeyB64: z.string().min(1).max(PAIRING_PUBLIC_KEY_MAX_CHARACTERS),
      scope: PairingScopeSchema.optional(),
      relay: relaySchema.optional(),
      // Why: absent means the v2 legacy direct/Relay strategy; only an explicit
      // marker lets a new client apply authoritative sequential route order.
      routeOrder: z.literal(1).optional(),
      // Why: Relay stays a separate credential object for old clients, while
      // this compact index lets new clients insert it into direct route order.
      relayPreferenceIndex: z.number().int().min(0).max(MAX_PAIRING_ENDPOINTS).optional()
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
      const directCount = offer.endpoints?.length ?? 1
      if (offer.relayPreferenceIndex !== undefined && !offer.relay) {
        ctx.addIssue({
          code: 'custom',
          path: ['relayPreferenceIndex'],
          message: 'Relay preference requires Relay metadata'
        })
      } else if (
        offer.relayPreferenceIndex !== undefined &&
        offer.relayPreferenceIndex > directCount
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['relayPreferenceIndex'],
          message: 'Relay preference exceeds direct route count'
        })
      }
      if (offer.routeOrder !== 1 && offer.relayPreferenceIndex !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['routeOrder'],
          message: 'Ordered routes require an explicit route-order marker'
        })
      }
      if (new TextEncoder().encode(JSON.stringify(offer)).length > MAX_PAIRING_OFFER_JSON_BYTES) {
        ctx.addIssue({
          code: 'custom',
          message: 'Pairing offer is too large for a reliable QR code'
        })
      }
    })
}

export const PairingOfferSchema = createPairingOfferSchema()
export type PairingOffer = z.infer<typeof PairingOfferSchema>
export type PairingRelay = NonNullable<PairingOffer['relay']>

import * as z from 'zod'
import {
  PAIRING_DEVICE_TOKEN_MAX_CHARACTERS,
  PAIRING_ENDPOINT_MAX_CHARACTERS,
  PAIRING_IROH_DIRECT_ADDRESS_MAX_CHARACTERS,
  PAIRING_IROH_DIRECT_ADDRESS_MAX_COUNT,
  PAIRING_IROH_ENDPOINT_ID_PATTERN,
  PAIRING_PUBLIC_KEY_MAX_CHARACTERS,
  PAIRING_RELAY_URL_MAX_CHARACTERS
} from './mobile-pairing-protocol-limits'
import { RuntimeHostDescriptorSchema } from '../host-status/runtime-host-descriptor'
import { parseIrohRelayUrl } from '../../iroh-relay-preference'

export const PAIRING_OFFER_VERSION = 2
const PairingScopeSchema = z.enum(['mobile', 'runtime'])
const BASE64URL_16_PATTERN = /^[A-Za-z0-9_-]{16}$/
const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_INVITE_TTL_MS = 10 * 60 * 1000
// Cell-stamped expiry needs skew leeway or an ahead cell clock invalidates every invite (as with host-proof freshness).
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

/** Accept explicit relay origins, including the SDK's trailing slash, without URL repair or secrets. */
function isIrohRelayOrigin(value: string): boolean {
  try {
    return value === value.trim() && parseIrohRelayUrl(value) !== null
  } catch {
    return false
  }
}

const IrohIpv4Schema = z.ipv4()
const IrohIpv6Schema = z.ipv6()

/** Match Rust SocketAddr formatting, retaining numeric IPv6 scope IDs and IPv4-mapped IPv6. */
function isIrohSocketAddress(value: string): boolean {
  const socket = /^(?:([0-9.]+)|\[([0-9a-f:.]+)(?:%([0-9]+))?\]):([0-9]{1,5})$/i.exec(value)
  if (!socket || Number(socket[4]) > 65535) {
    return false
  }
  if (socket[3] && Number(socket[3]) > 0xffffffff) {
    return false
  }
  return (socket[1] ? IrohIpv4Schema : IrohIpv6Schema).safeParse(socket[1] ?? socket[2]).success
}

export const PairingIrohSchema = z.object({
  endpointId: z.string().regex(PAIRING_IROH_ENDPOINT_ID_PATTERN),
  // Dial hints preserve offline-LAN connections and skip discovery, but are untrusted input.
  relayUrl: z
    .string()
    .min(1)
    .max(PAIRING_RELAY_URL_MAX_CHARACTERS)
    .refine(
      isIrohRelayOrigin,
      'Expected HTTPS relay origin without credentials, paths, queries or fragments'
    )
    .optional(),
  directAddresses: z
    .array(
      z
        .string()
        .min(1)
        .max(PAIRING_IROH_DIRECT_ADDRESS_MAX_CHARACTERS)
        .refine(isIrohSocketAddress, 'Expected IP socket address with a port from 0 to 65535')
    )
    .max(PAIRING_IROH_DIRECT_ADDRESS_MAX_COUNT)
    .optional()
})

/** Validate v2 pairing offers, bounding iroh dial hints and enforcing Relay scope, key and expiry rules. */
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
      v: z.literal(PAIRING_OFFER_VERSION),
      endpoint: z.string().min(1).max(PAIRING_ENDPOINT_MAX_CHARACTERS),
      deviceToken: z.string().min(1).max(PAIRING_DEVICE_TOKEN_MAX_CHARACTERS),
      // Pairing pins the Curve25519 key; verify relayHostId from its decoded bytes later.
      publicKeyB64: z.string().min(1).max(PAIRING_PUBLIC_KEY_MAX_CHARACTERS),
      pairedDeviceId: z.string().min(1).max(128).optional(),
      scope: PairingScopeSchema.optional(),
      relay: relaySchema.optional(),
      iroh: PairingIrohSchema.optional(),
      // Why catch: a descriptor this build cannot read is dropped, never a reason to refuse pairing.
      hostDescriptor: RuntimeHostDescriptorSchema.optional().catch(undefined)
    })
    .superRefine((offer, ctx) => {
      if (offer.relay && offer.scope === 'runtime') {
        // Relay v1 supports mobile only; runtime offers would promise unsupported routing/credentials.
        ctx.addIssue({
          code: 'custom',
          path: ['relay'],
          message: 'Relay is invalid for runtime scope'
        })
      }
      if (offer.relay && !isCanonicalBase64Key(offer.publicKeyB64)) {
        // relayHostId derives from decoded bytes; refuse permissive legacy base64 aliases here.
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
export type PairingIroh = NonNullable<PairingOffer['iroh']>

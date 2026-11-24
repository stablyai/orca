import { sha256 } from '@noble/hashes/sha256'
import * as z from 'zod'
import type { PairedE2EEPrimitives } from '../remote-runtime/e2ee/paired-e2ee-primitives'
import {
  encodeDeviceProofMessage,
  verifyDeviceProof
} from '../remote-runtime/pairing/device-key-proof'
import { PAIRING_RELAY_OFFER_FIELDS } from '../remote-runtime/pairing/mobile-relay-pairing-offer'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../agent-session/agent-session-attachments'
import {
  Identifier,
  SessionId
} from '../rpc-contract/structured-agent-session/structured-agent-session-identifiers'

// What Orca Cloud carries between a shared bot's host and a teammate's device, sealed with a fresh
// key so the cloud can't read it: the host's relay offer, and a held message. Platform crypto is
// injected (desktop: Node, phone: Hermes), as the pairing handshake's is.

const Id = Identifier('Invalid id', 128)
const Curve25519Key = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)

// The host's answer to a share_accept: how the device reaches the bot over the relay, the host key it
// pins there, and its share device id. The device checks the invite's expiry when it connects and
// accepts again once it has passed.
export const BotTeamShareOffer = z.object({
  v: z.literal(1),
  relay: z.object({ ...PAIRING_RELAY_OFFER_FIELDS, inviteExpiresAt: z.number().int() }),
  hostPublicKeyB64: Curve25519Key,
  deviceId: Id,
  botId: Id
})
export type BotTeamShareOffer = z.infer<typeof BotTeamShareOffer>

// A teammate's message to a shared bot whose host is away, held until the host is back. Signed inside
// by the teammate's device key, so the cloud can't forge one.

export const BotTeamShareHeldMessage = z.object({
  v: z.literal(1),
  shareId: Id,
  botId: Id,
  // A chat of theirs, or a new one, keyed so a retry can't start two.
  chat: z.union([z.object({ sessionId: SessionId }), z.object({ newChatId: Id })]),
  clientMessageId: Id,
  text: z.string(),
  attachments: z
    .array(z.object({ name: z.string().min(1).max(1024), contentBase64: z.string() }))
    .max(AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT),
  sentAt: z.number().int().nonnegative(),
  // The signing device's Ed25519 key; the host trusts it only as a share device row of its own.
  devicePublicKey: z.string()
})
export type BotTeamShareHeldMessage = z.infer<typeof BotTeamShareHeldMessage>

type SealPrimitives = Pick<
  PairedE2EEPrimitives,
  | 'generateKeyPair'
  | 'deriveSharedKey'
  | 'sealLegacyBinary'
  | 'openLegacyBinary'
  | 'encodeBase64'
  | 'decodeBase64'
  | 'publicKeyFromBase64'
>

const KEY_BYTES = 32
const SIGNATURE_BYTES = 64

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** `ephemeral public key ‖ box(plaintext)`, base64. */
function sealTo(primitives: SealPrimitives, recipientKey: string, plaintext: Uint8Array): string {
  const ephemeral = primitives.generateKeyPair()
  const sharedKey = primitives.deriveSharedKey(
    ephemeral.secretKey,
    primitives.publicKeyFromBase64(recipientKey)
  )
  return primitives.encodeBase64(
    concat(ephemeral.publicKey, primitives.sealLegacyBinary(plaintext, sharedKey))
  )
}

/** The plaintext, or null for anything this key didn't seal. Throws on input that isn't base64. */
function openWith(
  primitives: SealPrimitives,
  secretKey: Uint8Array,
  sealed: string
): Uint8Array | null {
  const bytes = primitives.decodeBase64(sealed)
  const sharedKey = primitives.deriveSharedKey(secretKey, bytes.subarray(0, KEY_BYTES))
  return primitives.openLegacyBinary(bytes.subarray(KEY_BYTES), sharedKey)
}

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
const parsed = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes))

/** The offer sealed to the device's sealKey (share_accept), as the host PUTs it. */
export function sealBotTeamShareOffer(
  primitives: SealPrimitives,
  args: { sealKey: string; offer: BotTeamShareOffer }
): string {
  return sealTo(primitives, args.sealKey, json(args.offer))
}

/** The offer, or null unless this device's seal key opens it and it is for the bot asked for. */
export function openBotTeamShareOffer(
  primitives: SealPrimitives,
  args: { sealSecretKey: Uint8Array; sealed: string; expect: { botId: string } }
): BotTeamShareOffer | null {
  try {
    const plaintext = openWith(primitives, args.sealSecretKey, args.sealed)
    const offer = plaintext ? BotTeamShareOffer.safeParse(parsed(plaintext)).data : undefined
    return offer?.botId === args.expect.botId ? offer : null
  } catch {
    return null
  }
}

/** `ephemeral public key ‖ box(signature ‖ message JSON)`, base64: what the cloud holds. */
export async function sealBotTeamShareHeldMessage(
  primitives: SealPrimitives,
  args: {
    hostKey: string
    message: BotTeamShareHeldMessage
    sign: (message: Uint8Array) => Promise<Uint8Array>
  }
): Promise<string> {
  const body = json(args.message)
  const signature = await args.sign(encodeDeviceProofMessage('share-send', sha256(body)))
  if (signature.length !== SIGNATURE_BYTES) {
    throw new Error('held message needs a 64-byte signature')
  }
  return sealTo(primitives, args.hostKey, concat(signature, body))
}

/**
 * The message, or null unless this host's key opens it, its device key signed it for share-send, and
 * it names the delivery's share, bot and clientMessageId. The caller still checks that key against its
 * share device rows and stamps the sender from that row.
 */
export function openBotTeamShareHeldMessage(
  primitives: SealPrimitives,
  args: {
    hostSecretKey: Uint8Array
    sealed: string
    expect: { shareId: string; botId: string; clientMessageId: string }
  }
): BotTeamShareHeldMessage | null {
  try {
    const plaintext = openWith(primitives, args.hostSecretKey, args.sealed)
    if (!plaintext || plaintext.length <= SIGNATURE_BYTES) {
      return null
    }
    const body = plaintext.subarray(SIGNATURE_BYTES)
    const message = BotTeamShareHeldMessage.safeParse(parsed(body))
    if (
      !message.success ||
      message.data.shareId !== args.expect.shareId ||
      message.data.botId !== args.expect.botId ||
      message.data.clientMessageId !== args.expect.clientMessageId
    ) {
      return null
    }
    const signed = verifyDeviceProof({
      devicePublicKeyB64: message.data.devicePublicKey,
      deviceProofB64: primitives.encodeBase64(plaintext.subarray(0, SIGNATURE_BYTES)),
      purpose: 'share-send',
      transcriptHashB64: primitives.encodeBase64(sha256(body))
    })
    return signed ? message.data : null
  } catch {
    return null
  }
}

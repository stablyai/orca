import { sha256 } from '@noble/hashes/sha256'
import * as z from 'zod'
import type { PairedE2EEPrimitives } from '../remote-runtime/e2ee/paired-e2ee-primitives'
import {
  encodeDeviceProofMessage,
  verifyDeviceProof
} from '../remote-runtime/pairing/device-key-proof'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../agent-session/agent-session-attachments'
import {
  Identifier,
  SessionId
} from '../rpc-contract/structured-agent-session/structured-agent-session-identifiers'

// A teammate's message to a shared bot whose host is away, held by Orca Cloud until the host is back.
// Sealed to the host's E2EE key with a fresh key, so the cloud can't read it, and signed inside by the
// teammate's device key, so the cloud can't forge one. Platform crypto is injected (desktop: Node,
// phone: Hermes), as the pairing handshake's is.

const Id = Identifier('Invalid id', 128)

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

/** `ephemeral public key ‖ box(signature ‖ message JSON)`, base64: what the cloud holds. */
export async function sealBotTeamShareHeldMessage(
  primitives: SealPrimitives,
  args: {
    hostKey: string
    message: BotTeamShareHeldMessage
    sign: (message: Uint8Array) => Promise<Uint8Array>
  }
): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(args.message))
  const signature = await args.sign(encodeDeviceProofMessage('share-send', sha256(body)))
  if (signature.length !== SIGNATURE_BYTES) {
    throw new Error('held message needs a 64-byte signature')
  }
  const ephemeral = primitives.generateKeyPair()
  const sharedKey = primitives.deriveSharedKey(
    ephemeral.secretKey,
    primitives.publicKeyFromBase64(args.hostKey)
  )
  const box = primitives.sealLegacyBinary(concat(signature, body), sharedKey)
  return primitives.encodeBase64(concat(ephemeral.publicKey, box))
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
    const bytes = primitives.decodeBase64(args.sealed)
    const sharedKey = primitives.deriveSharedKey(args.hostSecretKey, bytes.subarray(0, KEY_BYTES))
    const plaintext = primitives.openLegacyBinary(bytes.subarray(KEY_BYTES), sharedKey)
    if (!plaintext || plaintext.length <= SIGNATURE_BYTES) {
      return null
    }
    const body = plaintext.subarray(SIGNATURE_BYTES)
    const message = BotTeamShareHeldMessage.safeParse(JSON.parse(new TextDecoder().decode(body)))
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

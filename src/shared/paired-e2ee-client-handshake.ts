import { encodeDeviceProofMessage } from './device-key-proof'
import type { MobileE2EETransport } from './mobile-e2ee-v2-contract'
import type { PairedE2EEKeyPair, PairedE2EEPrimitives } from './paired-e2ee-primitives'
import { PairedE2EEV2ClientSession } from './paired-e2ee-v2-client-session'

export type PairedE2EEFraming = 'legacy' | 'v2'

// Device-key/ticket credentials signed over the v2 transcript join this union.
export type PairedE2EEAuthCredential = { kind: 'token'; deviceToken: string }

// Sign the v2 auth transcript proof asynchronously so non-extractable WebCrypto keys can participate.
export type PairedE2EEDeviceKeyCredential = {
  kind: 'device-key'
  deviceId: string
  sign: (message: Uint8Array) => Promise<Uint8Array>
}

export type PairedE2EEReadyVerdict =
  | 'accepted'
  // Not JSON. Legacy clients treat this as an encrypted frame.
  | 'invalid'
  // JSON, but not a ready this hello accepts (wrong type, bad v2 transcript, re-keyed host).
  | 'unexpected'
  // A legacy ready from a host this client has seen speak v2.
  | 'downgrade_refused'

export type PairedE2EEAuthReply =
  | { kind: 'authenticated' }
  // errorDeviceId: the device a sealed verdict names (device_revoked); a client acts only on its own.
  | { kind: 'rejected'; type: string | null; errorCode: string | null; errorDeviceId?: string }
  | { kind: 'invalid' }

export type PairedE2EEChannel = {
  sealText: (plaintext: string) => string
  // null = not authentic (or not yet keyed).
  openText: (frame: string) => string | null
  sealBinary: (plaintext: Uint8Array) => Uint8Array<ArrayBuffer>
  openBinary: (frame: Uint8Array) => Uint8Array | null
}

// The client side of the per-host "v2 seen" latch. Only legacy framing consults it.
export type PairedE2EELegacyGate = {
  mayUseLegacy: () => boolean
}

export class PairedE2EEDowngradeError extends Error {
  constructor(stage: 'hello' | 'auth') {
    super(`host is latched to E2EE v2; refusing legacy ${stage}`)
  }
}

export type PairedE2EEClientHandshake = {
  readonly framing: PairedE2EEFraming
  // Valid once the ready is accepted (legacy: immediately).
  readonly channel: PairedE2EEChannel
  // Throws PairedE2EEDowngradeError for a legacy hello to a latched host.
  helloText: () => string
  acceptReadyText: (frame: string) => PairedE2EEReadyVerdict
  // This v2 connection’s transcript hash after ready; null for legacy framing.
  transcriptHashB64: () => string | null
  sealAuth: (
    credential: PairedE2EEAuthCredential | PairedE2EEDeviceKeyCredential,
    options?: { clientCapabilities?: readonly string[] }
  ) => Promise<string>
  classifyAuthReply: (plaintext: string) => PairedE2EEAuthReply
}

export type PairedE2EEClientHandshakeArgs = {
  primitives: PairedE2EEPrimitives
  hostPublicKeyB64: string
  framing: PairedE2EEFraming
  transport?: MobileE2EETransport
  relayHostId?: string
  legacyGate?: PairedE2EELegacyGate
  // Runtime clients pass their structure-limited parser and size-limited serializer.
  parseJson?: (text: string) => unknown
  serializeJson?: (value: unknown) => string
  clientKeyPair?: PairedE2EEKeyPair
  clientNonce?: Uint8Array
}

export function createPairedE2EEClientHandshake(
  args: PairedE2EEClientHandshakeArgs
): PairedE2EEClientHandshake {
  return args.framing === 'v2' ? createV2Handshake(args) : createLegacyHandshake(args)
}

function createLegacyHandshake(args: PairedE2EEClientHandshakeArgs): PairedE2EEClientHandshake {
  const { primitives } = args
  const parseJson = args.parseJson ?? JSON.parse
  const serializeJson = args.serializeJson ?? JSON.stringify
  const mayUseLegacy = (): boolean => args.legacyGate?.mayUseLegacy() ?? true
  const keyPair = args.clientKeyPair ?? primitives.generateKeyPair()
  const channel = createPairedE2EELegacyChannel(
    primitives,
    primitives.deriveSharedKey(
      keyPair.secretKey,
      primitives.publicKeyFromBase64(args.hostPublicKeyB64)
    )
  )
  return {
    framing: 'legacy',
    channel,
    helloText: () => {
      if (!mayUseLegacy()) {
        throw new PairedE2EEDowngradeError('hello')
      }
      return JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: primitives.publicKeyToBase64(keyPair.publicKey)
      })
    },
    acceptReadyText: (frame) => {
      const ready = parseJsonOrUndefined(frame, parseJson)
      if (ready === undefined) {
        return 'invalid'
      }
      if (readStringField(ready, 'type') !== 'e2ee_ready') {
        return 'unexpected'
      }
      // Another socket may have latched v2 while this one dialed; recheck downgrade policy.
      return mayUseLegacy() ? 'accepted' : 'downgrade_refused'
    },
    transcriptHashB64: () => null,
    sealAuth: async (credential, options) => {
      if (credential.kind !== 'token') {
        throw new Error('device-key credentials need E2EE v2')
      }
      if (!mayUseLegacy()) {
        throw new PairedE2EEDowngradeError('auth')
      }
      return channel.sealText(
        serializeJson({
          type: 'e2ee_auth',
          deviceToken: credential.deviceToken,
          ...(options?.clientCapabilities ? { clientCapabilities: options.clientCapabilities } : {})
        })
      )
    },
    classifyAuthReply: (plaintext) => {
      const reply = parseJsonOrUndefined(plaintext, parseJson)
      if (reply === undefined) {
        return { kind: 'invalid' }
      }
      const type = readStringField(reply, 'type')
      return type === 'e2ee_authenticated' ? { kind: 'authenticated' } : rejectedReply(reply)
    }
  }
}

export function createPairedE2EELegacyChannel(
  primitives: PairedE2EEPrimitives,
  sharedKey: Uint8Array
): PairedE2EEChannel {
  return {
    sealText: (plaintext) => primitives.sealLegacyText(plaintext, sharedKey),
    openText: (frame) => primitives.openLegacyText(frame, sharedKey),
    sealBinary: (plaintext) => primitives.sealLegacyBinary(plaintext, sharedKey),
    openBinary: (frame) => primitives.openLegacyBinary(frame, sharedKey)
  }
}

function createV2Handshake(args: PairedE2EEClientHandshakeArgs): PairedE2EEClientHandshake {
  const parseJson = args.parseJson ?? JSON.parse
  const serializeJson = args.serializeJson ?? JSON.stringify
  if (!args.transport) {
    throw new Error('E2EE v2 handshake requires a transport context')
  }
  const session = PairedE2EEV2ClientSession.create({
    primitives: args.primitives,
    desktopPublicKeyB64: args.hostPublicKeyB64,
    transport: args.transport,
    relayHostId: args.relayHostId,
    clientKeyPair: args.clientKeyPair,
    clientNonce: args.clientNonce
  })
  return {
    framing: 'v2',
    channel: session,
    helloText: () => JSON.stringify(session.hello),
    acceptReadyText: (frame) => {
      const ready = parseJsonOrUndefined(frame, parseJson)
      if (ready === undefined) {
        return 'invalid'
      }
      return session.acceptReady(ready) ? 'accepted' : 'unexpected'
    },
    transcriptHashB64: () => (session.isReady ? session.transcriptHashB64 : null),
    sealAuth: async (credential, options) => {
      // Why read first: throws before the ready, so nothing is signed without a transcript.
      const transcriptHashB64 = session.transcriptHashB64
      if (credential.kind === 'token') {
        // Why no capabilities: v2 token auth is an exact key set on every host.
        return session.sealText(
          serializeJson(pairedE2EEV2TokenAuth(transcriptHashB64, credential.deviceToken))
        )
      }
      const signature = await credential.sign(
        encodeDeviceProofMessage('auth', args.primitives.decodeBase64(transcriptHashB64))
      )
      return session.sealText(
        serializeJson({
          type: 'e2ee_auth',
          v: 2,
          transcriptHashB64,
          deviceId: credential.deviceId,
          deviceProofB64: args.primitives.encodeBase64(signature),
          ...(options?.clientCapabilities ? { clientCapabilities: options.clientCapabilities } : {})
        })
      )
    },
    classifyAuthReply: (plaintext) => {
      const reply = parseJsonOrUndefined(plaintext, parseJson)
      return reply === undefined
        ? { kind: 'invalid' }
        : classifyPairedE2EEV2AuthReply(reply, session.transcriptHashB64)
    }
  }
}

export function pairedE2EEV2TokenAuth(
  transcriptHashB64: string,
  deviceToken: string
): { type: 'e2ee_auth'; v: 2; transcriptHashB64: string; deviceToken: string } {
  return { type: 'e2ee_auth', v: 2, transcriptHashB64, deviceToken }
}

export function classifyPairedE2EEV2AuthReply(
  reply: unknown,
  transcriptHashB64: string
): PairedE2EEAuthReply {
  // Why exact: the authenticated reply must echo this session's transcript.
  const authenticated =
    isRecord(reply) &&
    Object.keys(reply).sort().join(',') === 'transcriptHashB64,type,v' &&
    reply.type === 'e2ee_authenticated' &&
    reply.v === 2 &&
    reply.transcriptHashB64 === transcriptHashB64
  return authenticated ? { kind: 'authenticated' } : rejectedReply(reply)
}

function parseJsonOrUndefined(text: string, parseJson: (text: string) => unknown): unknown {
  try {
    return parseJson(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return null
  }
  const fieldValue = value[field]
  return typeof fieldValue === 'string' ? fieldValue : null
}

function rejectedReply(reply: unknown): PairedE2EEAuthReply {
  const errorDeviceId = isRecord(reply) ? readStringField(reply.error, 'deviceId') : null
  return {
    kind: 'rejected',
    type: readStringField(reply, 'type'),
    errorCode: readErrorCode(reply),
    ...(errorDeviceId ? { errorDeviceId } : {})
  }
}

function readErrorCode(value: unknown): string | null {
  return isRecord(value) ? readStringField(value.error, 'code') : null
}

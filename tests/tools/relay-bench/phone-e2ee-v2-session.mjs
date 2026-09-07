// The mobile E2EE v2 client handshake, re-implemented in plain JS so the relay bench can run
// outside the React Native bundle. Mirrors mobile/src/transport/mobile-e2ee-v2-client-session.ts
// plus the encodings in src/shared/mobile-e2ee-v2-contract.ts and mobile-e2ee-v2-framing.ts.
// phone-e2ee-desktop-parity.test.mjs pins it to the real desktop responder.
import { createHash, hkdfSync } from 'node:crypto'
import { createRequire } from 'node:module'

const nacl = createRequire(import.meta.url)('tweetnacl')

const TRANSCRIPT_DOMAIN = 'orca-mobile-e2ee/v2/transcript'
const SALT_LABEL = utf8('orca-mobile-e2ee/v2/salt\0')
const INFO_LABEL = utf8('orca-mobile-e2ee/v2/session\0')
const NONCE_LENGTH = 24
const SESSION_ID_LENGTH = 32
const HEADER_LENGTH = SESSION_ID_LENGTH + 1 + 1 + 8

// ---------- byte helpers ----------
export function utf8(value) {
  return new TextEncoder().encode(value)
}
function uint32(value) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
export function sha256(bytes) {
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}
function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}
function unb64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'))
}
export function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}
function writeU64(target, offset, value) {
  new DataView(target.buffer, target.byteOffset).setBigUint64(offset, value)
}
// Transcript list encodings must stay byte-identical to encodeMobileE2EEV2Transcript in
// src/shared/mobile-e2ee-v2-contract.ts, or the derived key schedule diverges silently.
function encodeStringList(items) {
  return concat([
    uint32(items.length),
    ...items.map((value) => concat([uint32(value.length), value]))
  ])
}
function encodeNumberList(items) {
  return concat([uint32(items.length), ...items.map(uint32)])
}

// ---------- E2EE v2 (mirrors mobile/src/transport/mobile-e2ee-v2-client-session.ts) ----------
export class PhoneE2EE {
  constructor(desktopPublicKeyB64, relayHostId) {
    this.keys = nacl.box.keyPair()
    this.desktopPublicKey = unb64(desktopPublicKeyB64)
    this.clientNonce = nacl.randomBytes(32)
    this.hello = {
      type: 'e2ee_hello',
      v: 2,
      clientPublicKeyB64: b64(this.keys.publicKey),
      clientNonceB64: b64(this.clientNonce),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context: {
        protocol: 'orca-mobile-e2ee',
        initiator: 'mobile',
        responder: 'desktop',
        transport: 'relay',
        relayHostId
      }
    }
    this.inbound = 0n
    this.outbound = 0n
  }

  acceptReady(ready) {
    if (ready?.type !== 'e2ee_ready' || ready.v !== 2) {
      throw new Error('bad e2ee_ready')
    }
    const desktopPublicKey = unb64(ready.desktopPublicKeyB64)
    if (!nacl.verify(desktopPublicKey, this.desktopPublicKey)) {
      throw new Error('desktop key mismatch')
    }
    const desktopNonce = unb64(ready.desktopNonceB64)
    const hello = this.hello
    const fields = [
      ['domain', utf8(TRANSCRIPT_DOMAIN)],
      ['mobile-to-desktop.type', utf8(hello.type)],
      ['mobile-to-desktop.version', uint32(hello.v)],
      ['mobile-to-desktop.client-public-key', this.keys.publicKey],
      ['mobile-to-desktop.client-nonce', this.clientNonce],
      ['mobile-to-desktop.capabilities.framing', encodeNumberList(hello.capabilities.framing)],
      [
        'mobile-to-desktop.capabilities.payload-kinds',
        encodeStringList(hello.capabilities.payloadKinds.map(utf8))
      ],
      ['mobile-to-desktop.context.protocol', utf8(hello.context.protocol)],
      ['mobile-to-desktop.context.initiator', utf8(hello.context.initiator)],
      ['mobile-to-desktop.context.responder', utf8(hello.context.responder)],
      ['mobile-to-desktop.context.transport', utf8(hello.context.transport)],
      ['mobile-to-desktop.context.relay-host-id', utf8(hello.context.relayHostId ?? '')],
      ['desktop-to-mobile.type', utf8(ready.type)],
      ['desktop-to-mobile.version', uint32(ready.v)],
      ['desktop-to-mobile.desktop-public-key', desktopPublicKey],
      ['desktop-to-mobile.client-nonce-echo', this.clientNonce],
      ['desktop-to-mobile.desktop-nonce', desktopNonce],
      ['desktop-to-mobile.selection.framing', uint32(ready.selection.framing)],
      [
        'desktop-to-mobile.selection.payload-kinds',
        encodeStringList(ready.selection.payloadKinds.map(utf8))
      ],
      ['desktop-to-mobile.context.protocol', utf8(ready.context.protocol)],
      ['desktop-to-mobile.context.initiator', utf8(ready.context.initiator)],
      ['desktop-to-mobile.context.responder', utf8(ready.context.responder)],
      ['desktop-to-mobile.context.transport', utf8(ready.context.transport)],
      ['desktop-to-mobile.context.relay-host-id', utf8(ready.context.relayHostId ?? '')]
    ]
    const transcript = concat(
      fields.map(([name, value]) =>
        concat([uint32(utf8(name).length), utf8(name), uint32(value.length), value])
      )
    )
    const shared = nacl.box.before(this.desktopPublicKey, this.keys.secretKey)
    const transcriptHash = sha256(transcript)
    const salt = sha256(concat([SALT_LABEL, this.clientNonce, desktopNonce]))
    const info = concat([INFO_LABEL, transcriptHash])
    const expanded = new Uint8Array(hkdfSync('sha256', shared, salt, info, 96))
    this.m2d = expanded.slice(0, 32)
    this.d2m = expanded.slice(32, 64)
    this.sessionId = expanded.slice(64, 96)
    this.transcriptHashB64 = b64(transcriptHash)
  }

  frameNonce(direction, kind, counter) {
    const nonce = new Uint8Array(NONCE_LENGTH)
    nonce.set(this.sessionId.subarray(0, 12), 0)
    nonce[12] = 2
    nonce[13] = direction
    nonce[14] = kind
    nonce[15] = 0
    writeU64(nonce, 16, counter)
    return nonce
  }

  frameHeader(direction, kind, counter) {
    const header = new Uint8Array(HEADER_LENGTH)
    header.set(this.sessionId, 0)
    header[SESSION_ID_LENGTH] = direction
    header[SESSION_ID_LENGTH + 1] = kind
    writeU64(header, SESSION_ID_LENGTH + 2, counter)
    return header
  }

  sealText(plaintext) {
    const counter = this.outbound++
    const nonce = this.frameNonce(0, 0, counter)
    const body = concat([this.frameHeader(0, 0, counter), utf8(plaintext)])
    return b64(concat([nonce, nacl.secretbox(body, nonce, this.m2d)]))
  }

  // The inbound counter is shared across text and binary, so every inbound frame must be
  // consumed here even when the caller discards it, or the next open() nonce is off by one.
  open(frame, kind) {
    const counter = this.inbound++
    const nonce = this.frameNonce(1, kind, counter)
    if (!nacl.verify(frame.subarray(0, NONCE_LENGTH), nonce)) {
      throw new Error('nonce mismatch')
    }
    const plain = nacl.secretbox.open(frame.subarray(NONCE_LENGTH), nonce, this.d2m)
    if (!plain) {
      throw new Error('open failed')
    }
    if (!nacl.verify(plain.subarray(0, HEADER_LENGTH), this.frameHeader(1, kind, counter))) {
      throw new Error('header mismatch')
    }
    return plain.slice(HEADER_LENGTH)
  }

  openText(frameB64) {
    return new TextDecoder().decode(this.open(unb64(frameB64), 0))
  }
}

import nacl from 'tweetnacl'
import type { MobileE2EEPayloadKind } from './mobile-e2ee-v2-contract'

export type MobileE2EEDirection = 'mobile-to-desktop' | 'desktop-to-mobile'

const NONCE_LENGTH = 24
const SESSION_ID_LENGTH = 32
const HEADER_LENGTH = SESSION_ID_LENGTH + 1 + 1 + 8
const FRAME_VERSION = 2
const MAX_COUNTER = (1n << 64n) - 1n

export function sealMobileE2EEV2Frame(args: {
  payload: Uint8Array
  key: Uint8Array
  sessionId: Uint8Array
  direction: MobileE2EEDirection
  payloadKind: MobileE2EEPayloadKind
  counter: bigint
}): Uint8Array {
  validateFrameInputs(args.key, args.sessionId, args.counter)
  const header = encodeHeader(args)
  const nonce = encodeNonce(args)
  const plaintext = concatBytes([header, args.payload])
  const ciphertext = nacl.secretbox(plaintext, nonce, args.key)
  return concatBytes([nonce, ciphertext])
}

export function openMobileE2EEV2Frame(args: {
  frame: Uint8Array
  key: Uint8Array
  sessionId: Uint8Array
  direction: MobileE2EEDirection
  payloadKind: MobileE2EEPayloadKind
  expectedCounter: bigint
}): Uint8Array | null {
  validateFrameInputs(args.key, args.sessionId, args.expectedCounter)
  if (args.frame.length < NONCE_LENGTH + nacl.secretbox.overheadLength + HEADER_LENGTH) {
    return null
  }
  const expected = {
    sessionId: args.sessionId,
    direction: args.direction,
    payloadKind: args.payloadKind,
    counter: args.expectedCounter
  }
  const nonce = encodeNonce(expected)
  if (!equalBytes(args.frame.subarray(0, NONCE_LENGTH), nonce)) {
    return null
  }

  const plaintext = nacl.secretbox.open(args.frame.subarray(NONCE_LENGTH), nonce, args.key)
  if (!plaintext) {
    return null
  }
  const header = encodeHeader(expected)
  if (!equalBytes(plaintext.subarray(0, HEADER_LENGTH), header)) {
    return null
  }
  return plaintext.slice(HEADER_LENGTH)
}

function encodeHeader(args: {
  sessionId: Uint8Array
  direction: MobileE2EEDirection
  payloadKind: MobileE2EEPayloadKind
  counter: bigint
}): Uint8Array {
  const header = new Uint8Array(HEADER_LENGTH)
  header.set(args.sessionId, 0)
  header[SESSION_ID_LENGTH] = directionByte(args.direction)
  header[SESSION_ID_LENGTH + 1] = payloadKindByte(args.payloadKind)
  writeUint64(header, SESSION_ID_LENGTH + 2, args.counter)
  return header
}

function encodeNonce(args: {
  sessionId: Uint8Array
  direction: MobileE2EEDirection
  payloadKind: MobileE2EEPayloadKind
  counter: bigint
}): Uint8Array {
  const nonce = new Uint8Array(NONCE_LENGTH)
  // Why: v2 keys/sessionId are fresh per socket; the fixed layout makes every
  // direction/kind/counter nonce unique without relying on another RNG draw.
  nonce.set(args.sessionId.subarray(0, 12), 0)
  nonce[12] = FRAME_VERSION
  nonce[13] = directionByte(args.direction)
  nonce[14] = payloadKindByte(args.payloadKind)
  nonce[15] = 0
  writeUint64(nonce, 16, args.counter)
  return nonce
}

function directionByte(direction: MobileE2EEDirection): number {
  return direction === 'mobile-to-desktop' ? 0 : 1
}

function payloadKindByte(kind: MobileE2EEPayloadKind): number {
  return kind === 'text' ? 0 : 1
}

function validateFrameInputs(key: Uint8Array, sessionId: Uint8Array, counter: bigint): void {
  if (key.length !== nacl.secretbox.keyLength) {
    throw new Error(`Invalid E2EE v2 key length: ${key.length}`)
  }
  if (sessionId.length !== SESSION_ID_LENGTH) {
    throw new Error(`Invalid E2EE v2 session ID length: ${sessionId.length}`)
  }
  if (counter < 0n || counter > MAX_COUNTER) {
    throw new Error(`Invalid E2EE v2 counter: ${counter}`)
  }
}

function writeUint64(target: Uint8Array, offset: number, value: bigint): void {
  let remaining = value
  for (let index = 7; index >= 0; index--) {
    target[offset + index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

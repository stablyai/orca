import nacl from 'tweetnacl'

export type DeviceProofPurpose = 'auth' | 'redeem' | 'register'

const DOMAIN = 'orca-device-proof/v1'
const TRANSCRIPT_HASH_BYTES = 32
const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64

/** `orca-device-proof/v1 \0 purpose \0 transcriptHash`: one connection, one purpose. */
export function encodeDeviceProofMessage(
  purpose: DeviceProofPurpose,
  transcriptHash: Uint8Array
): Uint8Array {
  if (transcriptHash.length !== TRANSCRIPT_HASH_BYTES) {
    throw new Error('device proof needs a 32-byte transcript hash')
  }
  const prefix = new TextEncoder().encode(`${DOMAIN}\0${purpose}\0`)
  const message = new Uint8Array(prefix.length + transcriptHash.length)
  message.set(prefix)
  message.set(transcriptHash, prefix.length)
  return message
}

export function decodeCanonicalBase64(value: unknown, byteLength: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return null
  }
  try {
    const binary = atob(value)
    if (binary.length !== byteLength || btoa(binary) !== value) {
      return null
    }
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

export function isDevicePublicKeyB64(value: unknown): value is string {
  return decodeCanonicalBase64(value, PUBLIC_KEY_BYTES) !== null
}

export function isDeviceProofB64(value: unknown): value is string {
  return decodeCanonicalBase64(value, SIGNATURE_BYTES) !== null
}

export function verifyDeviceProof(args: {
  devicePublicKeyB64: unknown
  deviceProofB64: unknown
  purpose: DeviceProofPurpose
  transcriptHashB64: string
}): boolean {
  const publicKey = decodeCanonicalBase64(args.devicePublicKeyB64, PUBLIC_KEY_BYTES)
  const signature = decodeCanonicalBase64(args.deviceProofB64, SIGNATURE_BYTES)
  const transcriptHash = decodeCanonicalBase64(args.transcriptHashB64, TRANSCRIPT_HASH_BYTES)
  if (!publicKey || !signature || !transcriptHash) {
    return false
  }
  return nacl.sign.detached.verify(
    encodeDeviceProofMessage(args.purpose, transcriptHash),
    signature,
    publicKey
  )
}

// Remove controls/bidi from approval/device-list labels so one device cannot disguise itself as another.
export function sanitizeDeviceLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
  return cleaned.length > 0 ? cleaned : fallback
}

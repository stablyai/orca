import { sha256 } from '@noble/hashes/sha256'

// Hash serialized bearer text, not decoded random bytes, to match the relay’s stored credential digest.
export function hashRelayCredential(token: string): string {
  return encodeBase64Url(sha256(new TextEncoder().encode(token)))
}

/** A fresh 32-byte relay resume credential; only its hash ever leaves this device. */
export function mintRelayCredential(randomBytes: (length: number) => Uint8Array): {
  token: string
  hash: string
} {
  const token = encodeBase64Url(randomBytes(32))
  return { token, hash: hashRelayCredential(token) }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

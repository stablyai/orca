// Opens a workspace access grant sealed by the workspace VM (image/vm/orca-sandbox-grant in the
// sandbox control plane). The control plane relays only this box; the device that asked for the
// grant is the only holder of the X25519 secret that opens it, so the VM owner's E2EE model holds.
//
// Exact construction (keep in sync with the VM sealer):
//   shared = X25519(recipientSecret, ephemeralPublic)
//   key    = HKDF-SHA256(ikm = shared, salt = ephemeralPublic(32) || recipientPublic(32),
//                        info = utf8 "orca-cloud-grant-v1", length = 32)
//   AES-256-GCM, 12-byte nonce, ciphertext = ct || tag(16), AAD = utf8 "orca-cloud-grant-v1:" + grantId
//   plaintext = utf8 JSON {pairingUrl, deviceId, scope}
// Free of node:crypto and Buffer so mobile (Hermes) can import it with its own primitives.

export const SEALED_GRANT_INFO = 'orca-cloud-grant-v1'

export type SealedGrant = {
  v: 1
  ephemeralPublicKeyB64: string
  nonceB64: string
  ciphertextB64: string
}

export type OpenedGrant = { pairingUrl: string; deviceId: string; scope: 'runtime' | 'mobile' }

export type SealedGrantPrimitives = {
  /** Raw X25519: scalar multiplication of `secretKey` (32 bytes) with `publicKey` (32 bytes). */
  x25519(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | Promise<Uint8Array>
  /** Public key for a 32-byte X25519 secret. */
  x25519PublicKey(secretKey: Uint8Array): Uint8Array | Promise<Uint8Array>
  hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number
  ): Uint8Array | Promise<Uint8Array>
  /** Throws when the tag does not verify. `ciphertext` includes the 16-byte tag at the end. */
  aesGcmDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    aad: Uint8Array
  ): Uint8Array | Promise<Uint8Array>
}

export class SealedGrantError extends Error {
  constructor(readonly code: 'malformed' | 'decrypt_failed' | 'invalid_payload') {
    super(code)
    this.name = 'SealedGrantError'
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) {
    throw new SealedGrantError('malformed')
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let acc = 0
  let index = 0
  for (const char of clean) {
    acc = (acc << 6) | B64.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (acc >> bits) & 0xff
    }
  }
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export async function openSealedGrant(
  sealed: SealedGrant,
  grantId: string,
  recipientSecretKey: Uint8Array,
  primitives: SealedGrantPrimitives,
  /** The credential kind this client can use; a grant minted for another kind is rejected. */
  expectedScope?: OpenedGrant['scope']
): Promise<OpenedGrant> {
  if (sealed.v !== 1 || recipientSecretKey.length !== 32) {
    throw new SealedGrantError('malformed')
  }
  const ephemeral = base64ToBytes(sealed.ephemeralPublicKeyB64)
  const nonce = base64ToBytes(sealed.nonceB64)
  const ciphertext = base64ToBytes(sealed.ciphertextB64)
  if (ephemeral.length !== 32 || nonce.length !== 12 || ciphertext.length < 17) {
    throw new SealedGrantError('malformed')
  }
  const encoder = new TextEncoder()
  const recipientPublic = await primitives.x25519PublicKey(recipientSecretKey)
  const shared = await primitives.x25519(recipientSecretKey, ephemeral)
  const key = await primitives.hkdfSha256(
    shared,
    concat(ephemeral, recipientPublic),
    encoder.encode(SEALED_GRANT_INFO),
    32
  )
  let plaintext: Uint8Array
  try {
    plaintext = await primitives.aesGcmDecrypt(
      key,
      nonce,
      ciphertext,
      encoder.encode(`${SEALED_GRANT_INFO}:${grantId}`)
    )
  } catch {
    throw new SealedGrantError('decrypt_failed')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    throw new SealedGrantError('invalid_payload')
  }
  const payload: Record<string, unknown> = isRecord(parsed) ? parsed : {}
  if (
    typeof payload.pairingUrl !== 'string' ||
    !payload.pairingUrl.startsWith('orca://pair?') ||
    typeof payload.deviceId !== 'string' ||
    (payload.scope !== 'runtime' && payload.scope !== 'mobile') ||
    (expectedScope !== undefined && payload.scope !== expectedScope)
  ) {
    throw new SealedGrantError('invalid_payload')
  }
  return { pairingUrl: payload.pairingUrl, deviceId: payload.deviceId, scope: payload.scope }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

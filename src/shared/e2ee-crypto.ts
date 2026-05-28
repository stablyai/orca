// Why: Orca's remote runtime transports share one NaCl box format across
// desktop, CLI, and mobile pairing. Keeping the Node-compatible primitives in
// shared code prevents the CLI from importing main-process modules.
import nacl from 'tweetnacl'

export function generateKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair()
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, ourSecretKey)
}

export function publicKeyFromBase64(b64: string): Uint8Array {
  const key = Uint8Array.from(Buffer.from(b64, 'base64'))
  if (key.length !== 32) {
    throw new Error(`Invalid public key: expected 32 bytes, got ${key.length}`)
  }
  return key
}

export function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

export function encrypt(plaintext: string, sharedKey: Uint8Array): string {
  const messageBytes = new TextEncoder().encode(plaintext)
  return Buffer.from(encryptBytes(messageBytes, sharedKey)).toString('base64')
}

export function decrypt(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = Uint8Array.from(Buffer.from(encrypted, 'base64'))
  const plaintext = decryptBytes(bundle, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

export function encryptBytes(
  plaintext: Uint8Array<ArrayBufferLike>,
  sharedKey: Uint8Array
): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey)

  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)

  return bundle
}

export function decryptBytes(bundle: Uint8Array, sharedKey: Uint8Array): Uint8Array | null {
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }

  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const ciphertext = bundle.slice(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)

  if (!plaintext) {
    return null
  }

  return plaintext
}

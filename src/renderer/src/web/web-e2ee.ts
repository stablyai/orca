import nacl from 'tweetnacl'
import { decodeBase64Bytes } from '@/lib/base64-bytes'

if (globalThis.crypto?.getRandomValues) {
  nacl.setPRNG((bytes, count) => {
    globalThis.crypto.getRandomValues(bytes.subarray(0, count) as Uint8Array<ArrayBuffer>)
  })
}

export function generateKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair()
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, ourSecretKey)
}

export function publicKeyFromBase64(b64: string): Uint8Array {
  const key = decodeBase64Bytes(b64)
  if (key.length !== 32) {
    throw new Error(`Invalid public key: expected 32 bytes, got ${key.length}`)
  }
  return key
}

export function publicKeyToBase64(key: Uint8Array): string {
  return bytesToBase64(key)
}

export function encrypt(plaintext: string, sharedKey: Uint8Array): string {
  return bytesToBase64(encryptBytes(new TextEncoder().encode(plaintext), sharedKey))
}

export function decrypt(encrypted: string, sharedKey: Uint8Array): string | null {
  const plaintext = decryptBytes(decodeBase64Bytes(encrypted), sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

export function encryptBytes(
  plaintext: Uint8Array<ArrayBufferLike>,
  sharedKey: Uint8Array
): Uint8Array<ArrayBuffer> {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey)
  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)
  return bundle
}

export function decryptBytes(
  bundle: Uint8Array<ArrayBufferLike>,
  sharedKey: Uint8Array
): Uint8Array<ArrayBuffer> | null {
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }
  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const ciphertext = bundle.slice(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)
  return plaintext ? new Uint8Array(plaintext) : null
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return window.btoa(binary)
}

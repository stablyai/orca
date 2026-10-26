import nacl from 'tweetnacl'
import type { WebDeviceKeyRecord, WebDeviceKeyStore } from './web-device-key-store'

/**
 * - persistent: a non-extractable Ed25519 key survives reloads.
 * - token-insecure-origin: plain http on another machine (no WebCrypto keys there); the pairing
 *   code stays in local storage and signs in, so reloads, new tabs and bookmarks keep working.
 * - session-no-ed25519: a secure page whose browser cannot make Ed25519 keys.
 */
export type WebDeviceKeySupport = 'persistent' | 'token-insecure-origin' | 'session-no-ed25519'

/** Supports that sign in with a device key rather than the stored pairing code. */
export type KeyedWebDeviceKeySupport = Exclude<WebDeviceKeySupport, 'token-insecure-origin'>

export type WebDeviceSigningKey = {
  publicKeyB64: string
  sign: (message: Uint8Array) => Promise<Uint8Array>
}

const ED25519 = { name: 'Ed25519' }

export async function detectWebDeviceKeySupport(scope: {
  isSecureContext: boolean
  crypto?: Crypto
  indexedDB?: IDBFactory
}): Promise<WebDeviceKeySupport> {
  if (!scope.isSecureContext) {
    return 'token-insecure-origin'
  }
  const subtle = scope.crypto?.subtle
  if (!subtle || !scope.indexedDB) {
    return 'session-no-ed25519'
  }
  try {
    await subtle.generateKey(ED25519, false, ['sign', 'verify'])
    return 'persistent'
  } catch {
    return 'session-no-ed25519'
  }
}

/** The stored key for `id`, creating a pending one; a tab that loses the create race adopts the winner's. */
export async function getOrCreatePendingWebDeviceKey(
  store: WebDeviceKeyStore,
  subtle: SubtleCrypto,
  id: string,
  pairingRevision?: number
): Promise<WebDeviceKeyRecord> {
  const existing = await store.get(id)
  if (existing) {
    return existing
  }
  const pair = await subtle.generateKey(ED25519, false, ['sign', 'verify'])
  if (!('privateKey' in pair)) {
    throw new Error('Ed25519 key generation returned no key pair')
  }
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
  const record: WebDeviceKeyRecord = {
    id,
    privateKey: pair.privateKey,
    publicKeyB64: bytesToBase64(publicKey),
    state: 'pending',
    ...(pairingRevision !== undefined ? { pairingRevision } : {})
  }
  if (await store.add(record)) {
    return record
  }
  const winner = await store.get(id)
  if (!winner) {
    throw new Error('Device key record vanished while another tab created it')
  }
  return winner
}

export function webDeviceSigningKey(
  subtle: SubtleCrypto,
  record: WebDeviceKeyRecord
): WebDeviceSigningKey {
  return {
    publicKeyB64: record.publicKeyB64,
    sign: async (message) =>
      new Uint8Array(await subtle.sign(ED25519, record.privateKey, new Uint8Array(message)))
  }
}

/** A key that lives only in this page's memory: the session-only fallback. */
export function createSessionDeviceSigningKey(): WebDeviceSigningKey {
  const pair = nacl.sign.keyPair()
  return {
    publicKeyB64: bytesToBase64(pair.publicKey),
    sign: async (message) => nacl.sign.detached(message, pair.secretKey)
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

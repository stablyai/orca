import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeDeviceProofMessage,
  verifyDeviceProof
} from '../../../shared/remote-runtime/pairing/device-key-proof'
import { getOrCreatePendingWebDeviceKey, webDeviceSigningKey } from './web-device-key'

import {
  createIndexedDbWebDeviceKeyStore,
  createMemoryWebDeviceKeyStore
} from './web-device-key-store'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node's webcrypto implements the SubtleCrypto surface these helpers call.
const subtle = webcrypto.subtle as unknown as SubtleCrypto
const transcriptHashB64 = Buffer.alloc(32, 7).toString('base64')

afterEach(() => {
  vi.unstubAllGlobals()
})

async function proof(key: { sign: (m: Uint8Array) => Promise<Uint8Array> }) {
  const message = encodeDeviceProofMessage('register', Buffer.from(transcriptHashB64, 'base64'))
  return Buffer.from(await key.sign(message)).toString('base64')
}

describe('browser device keys', () => {
  it('a WebCrypto Ed25519 signature verifies on the host (tweetnacl)', async () => {
    const record = await getOrCreatePendingWebDeviceKey(
      createMemoryWebDeviceKeyStore(),
      subtle,
      'h|e'
    )
    const key = webDeviceSigningKey(subtle, record)
    expect(record.privateKey.extractable).toBe(false)
    expect(
      verifyDeviceProof({
        devicePublicKeyB64: key.publicKeyB64,
        deviceProofB64: await proof(key),
        purpose: 'register',
        transcriptHashB64
      })
    ).toBe(true)
  })

  it('a second tab adopts the key the first tab stored', async () => {
    const store = createMemoryWebDeviceKeyStore()
    const [first, second] = await Promise.all([
      getOrCreatePendingWebDeviceKey(store, subtle, 'h|e'),
      getOrCreatePendingWebDeviceKey(store, subtle, 'h|e')
    ])
    expect(second.publicKeyB64).toBe(first.publicKeyB64)
    expect((await store.get('h|e'))?.publicKeyB64).toBe(first.publicKeyB64)
  })

  it('asks the browser not to evict the storage that holds device keys', () => {
    const persist = vi.fn(() => Promise.resolve(true))
    vi.stubGlobal('navigator', { storage: { persist } })
    createIndexedDbWebDeviceKeyStore({ open: vi.fn() })
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('does not touch IndexedDB or request persistence for session-only keys', async () => {
    vi.resetModules()
    const support = await import('./web-device-key-support')
    support.setWebDeviceKeySupportForTests('session-no-ed25519')
    const credentials = await import('./preload-api/web-runtime-credentials')
    const persist = vi.fn(() => Promise.resolve(true))
    const open = vi.fn()
    vi.stubGlobal('navigator', { storage: { persist } })
    vi.stubGlobal('indexedDB', { open })

    credentials.webRuntimeCredentialFor(
      {
        id: 'env-1',
        name: 'Server',
        createdAt: 1,
        updatedAt: 1,
        pairingRevision: 1,
        lastUsedAt: null,
        runtimeId: null,
        sessionOnly: true,
        preferredEndpointId: 'ws-env-1',
        endpoints: [
          {
            id: 'ws-env-1',
            kind: 'websocket',
            label: 'WebSocket',
            endpoint: 'ws://127.0.0.1:6768',
            deviceToken: 'code',
            publicKeyB64: Buffer.alloc(32).toString('base64')
          }
        ]
      },
      { forgetStoredToken: vi.fn(), forgetPairing: vi.fn() }
    )

    expect(persist).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})

import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeDeviceProofMessage, verifyDeviceProof } from '../../../shared/device-key-proof'
import { getOrCreatePendingWebDeviceKey, webDeviceSigningKey } from './web-device-key'

import { createMemoryWebDeviceKeyStore } from './web-device-key-store'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node's webcrypto implements the SubtleCrypto surface these helpers call.
const subtle = webcrypto.subtle as unknown as SubtleCrypto
const transcriptHashB64 = Buffer.alloc(32, 7).toString('base64')

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
})

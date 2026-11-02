import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import { encodeDeviceProofMessage, verifyDeviceProof } from './device-key-proof'
import { createMobileE2EEV2Fixture, MOBILE_E2EE_V2_VECTOR } from './mobile-e2ee-v2-fixtures'
import { openMobileE2EEV2Frame } from './mobile-e2ee-v2-framing'
import { createPairedE2EEClientHandshake } from './paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from './paired-e2ee-node-primitives'

const key = nacl.sign.keyPair()
const keyCredential = {
  kind: 'device-key' as const,
  deviceId: 'device-1',
  sign: async (message: Uint8Array) => nacl.sign.detached(message, key.secretKey)
}

function v2Handshake() {
  const fixture = createMobileE2EEV2Fixture()
  const handshake = createPairedE2EEClientHandshake({
    primitives: { ...NODE_PAIRED_E2EE_PRIMITIVES, deriveSharedKey: () => fixture.sharedSecret },
    hostPublicKeyB64: fixture.ready.desktopPublicKeyB64,
    framing: 'v2',
    transport: 'relay',
    relayHostId: fixture.hello.context.relayHostId,
    clientKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32) },
    clientNonce: new Uint8Array(32).fill(2)
  })
  expect(handshake.acceptReadyText(JSON.stringify(fixture.ready))).toBe('accepted')
  return handshake
}

function openAuth(frame: string): Record<string, unknown> {
  const plaintext = openMobileE2EEV2Frame({
    frame: Buffer.from(frame, 'base64'),
    key: Buffer.from(MOBILE_E2EE_V2_VECTOR.mobileToDesktopKeyHex, 'hex'),
    sessionId: Buffer.from(MOBILE_E2EE_V2_VECTOR.sessionIdHex, 'hex'),
    direction: 'mobile-to-desktop',
    payloadKind: 'text',
    expectedCounter: 0n
  })
  return JSON.parse(Buffer.from(plaintext!).toString())
}

describe('paired E2EE device-key auth', () => {
  it('signs this connection transcript with purpose auth and carries capabilities', async () => {
    const handshake = v2Handshake()
    const transcriptHashB64 = handshake.transcriptHashB64()!
    const auth = openAuth(await handshake.sealAuth(keyCredential, { clientCapabilities: ['a.v1'] }))
    expect(auth).toEqual({
      type: 'e2ee_auth',
      v: 2,
      transcriptHashB64,
      deviceId: 'device-1',
      deviceProofB64: expect.any(String),
      clientCapabilities: ['a.v1']
    })
    expect(
      verifyDeviceProof({
        devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
        deviceProofB64: auth.deviceProofB64,
        purpose: 'auth',
        transcriptHashB64
      })
    ).toBe(true)
    expect(
      verifyDeviceProof({
        devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
        deviceProofB64: auth.deviceProofB64,
        purpose: 'register',
        transcriptHashB64
      })
    ).toBe(false)
  })

  it('keeps v2 token auth exact-key, without capabilities', async () => {
    const auth = openAuth(
      await v2Handshake().sealAuth(
        { kind: 'token', deviceToken: 'token' },
        { clientCapabilities: ['a.v1'] }
      )
    )
    expect(Object.keys(auth).sort()).toEqual(['deviceToken', 'transcriptHashB64', 'type', 'v'])
  })

  it('refuses a device key over legacy framing and before the ready', async () => {
    const legacy = createPairedE2EEClientHandshake({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: Buffer.alloc(32, 9).toString('base64'),
      framing: 'legacy'
    })
    expect(legacy.transcriptHashB64()).toBeNull()
    await expect(legacy.sealAuth(keyCredential)).rejects.toThrow('E2EE v2')
    const fixture = createMobileE2EEV2Fixture()
    const early = createPairedE2EEClientHandshake({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: fixture.ready.desktopPublicKeyB64,
      framing: 'v2',
      transport: 'direct'
    })
    expect(early.transcriptHashB64()).toBeNull()
    await expect(early.sealAuth(keyCredential)).rejects.toThrow()
  })

  it('signs the documented proof message', async () => {
    const handshake = v2Handshake()
    const seen: Uint8Array[] = []
    await handshake.sealAuth({
      ...keyCredential,
      sign: async (message) => {
        seen.push(message)
        return nacl.sign.detached(message, key.secretKey)
      }
    })
    expect(seen[0]).toEqual(
      encodeDeviceProofMessage('auth', Buffer.from(handshake.transcriptHashB64()!, 'base64'))
    )
  })
})

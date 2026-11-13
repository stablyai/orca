import { describe, expect, it } from 'vitest'
import { createMobileE2EEV2Fixture, MOBILE_E2EE_V2_VECTOR } from './mobile-e2ee-v2-fixtures'
import { sealMobileE2EEV2Frame } from './mobile-e2ee-v2-framing'
import { createPairedE2EEClientHandshake } from './paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from './node/paired-e2ee-node-primitives'

describe('paired E2EE client handshake: v2 framing', () => {
  function v2Handshake() {
    const fixture = createMobileE2EEV2Fixture()
    const handshake = createPairedE2EEClientHandshake({
      // Why: the normative vector fixes the ECDH output, not a real key pair.
      primitives: { ...NODE_PAIRED_E2EE_PRIMITIVES, deriveSharedKey: () => fixture.sharedSecret },
      hostPublicKeyB64: fixture.ready.desktopPublicKeyB64,
      framing: 'v2',
      transport: 'relay',
      relayHostId: fixture.hello.context.relayHostId,
      clientKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32) },
      clientNonce: new Uint8Array(32).fill(2)
    })
    return { fixture, handshake }
  }

  it('opens host frames in counter order only', () => {
    const { fixture, handshake } = v2Handshake()
    handshake.acceptReadyText(JSON.stringify(fixture.ready))
    const seal = (text: string, counter: bigint) =>
      Buffer.from(
        sealMobileE2EEV2Frame({
          payload: new TextEncoder().encode(text),
          key: Buffer.from(MOBILE_E2EE_V2_VECTOR.desktopToMobileKeyHex, 'hex'),
          sessionId: Buffer.from(MOBILE_E2EE_V2_VECTOR.sessionIdHex, 'hex'),
          direction: 'desktop-to-mobile',
          payloadKind: 'text',
          counter
        })
      ).toString('base64')
    const first = seal('one', 0n)
    expect(handshake.channel.openText(first)).toBe('one')
    expect(handshake.channel.openText(first)).toBeNull()
    expect(handshake.channel.openText(seal('two', 1n))).toBe('two')
  })
})

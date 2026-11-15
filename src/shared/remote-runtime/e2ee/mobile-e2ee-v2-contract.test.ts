import { describe, expect, it } from 'vitest'
import { validateMobileE2EEV2Handshake } from './mobile-e2ee-v2-contract'
import { createMobileE2EEV2Fixture } from './mobile-e2ee-v2-fixtures'

describe('mobile E2EE v2 contract', () => {
  it('rejects an unechoed client nonce', () => {
    const { hello, ready } = createMobileE2EEV2Fixture()
    expect(
      validateMobileE2EEV2Handshake(hello, {
        ...ready,
        clientNonceB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
      })
    ).toBeNull()
  })

  it('rejects different relay contexts across the handshake', () => {
    const { hello, ready } = createMobileE2EEV2Fixture()
    expect(
      validateMobileE2EEV2Handshake(hello, {
        ...ready,
        context: { ...ready.context, relayHostId: 'ZbCdEf0123_-xyZ9' }
      })
    ).toBeNull()
  })
})

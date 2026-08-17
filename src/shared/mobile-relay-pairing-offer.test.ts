import { describe, expect, it } from 'vitest'
import { createPairingOfferSchema } from './mobile-relay-pairing-offer'
import { createMobileRelayPairingFixtures } from './mobile-relay-pairing-fixtures'

describe('desktop mobile-relay pairing contract', () => {
  const now = Date.UTC(2026, 6, 12, 16)
  const schema = createPairingOfferSchema(() => now)

  for (const fixture of createMobileRelayPairingFixtures(now)) {
    it(fixture.name, () => {
      const result = schema.safeParse(fixture.payload)
      expect(result.success ? result.data : null).toEqual(fixture.expected)
    })
  }

  it('preserves optional paired device identity', () => {
    const fixture = createMobileRelayPairingFixtures(now)[0]!
    if (!fixture.expected) {
      throw new Error('Expected a valid direct pairing fixture')
    }
    const payload = { ...fixture.expected, pairedDeviceId: 'paired-device-a' }

    expect(schema.parse(payload)).toMatchObject({ pairedDeviceId: 'paired-device-a' })
  })
})

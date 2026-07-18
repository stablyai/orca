import { describe, expect, it } from 'vitest'
import { createPairingOfferSchema } from './mobile-relay-pairing-offer'
import { MAX_PAIRING_OFFER_JSON_BYTES } from './mobile-relay-pairing-offer'
import { createMobileRelayPairingFixtures } from './mobile-relay-pairing-fixtures'
import QRCode from 'qrcode'

describe('desktop mobile-relay pairing contract', () => {
  const now = Date.UTC(2026, 6, 12, 16)
  const schema = createPairingOfferSchema(() => now)

  for (const fixture of createMobileRelayPairingFixtures(now)) {
    it(fixture.name, () => {
      const result = schema.safeParse(fixture.payload)
      expect(result.success ? result.data : null).toEqual(fixture.expected)
    })
  }

  it('accepts a bounded Relay insertion index', () => {
    const result = schema.safeParse({
      v: 2,
      endpoint: 'ws://100.64.1.20:6768',
      endpoints: ['ws://100.64.1.20:6768', 'ws://192.168.1.10:6768'],
      deviceToken: 'device-token',
      publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay-c1.onorca.dev',
        assignmentEpoch: 7,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
        inviteExpiresAt: now + 300_000,
        e2eeFraming: 2
      },
      relayPreferenceIndex: 1,
      routeOrder: 1
    })
    expect(result.success && result.data.relayPreferenceIndex).toBe(1)
  })

  it('rejects an offer whose combined address payload exceeds the QR budget', () => {
    const hostname = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}`
    const endpoints = Array.from({ length: 4 }, (_, index) => `ws://${index}${hostname}:6768`)
    expect(
      schema.safeParse({
        v: 2,
        endpoint: endpoints[0],
        endpoints,
        deviceToken: 'device-token',
        publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
      }).success
    ).toBe(false)
  })

  it('keeps the maximum accepted payload within the rendered QR density budget', () => {
    const base = {
      v: 2 as const,
      endpoint: 'ws://192.168.1.10:6768',
      deviceToken: '',
      publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    }
    let accepted = base
    for (let length = 1; length <= MAX_PAIRING_OFFER_JSON_BYTES; length += 1) {
      const candidate = { ...base, deviceToken: 'x'.repeat(length) }
      if (schema.safeParse(candidate).success) {
        accepted = candidate
      }
    }
    const json = JSON.stringify(accepted)
    const pairingUrl = `orca://pair?code=${Buffer.from(json).toString('base64url')}`
    const qr = QRCode.create(pairingUrl, { errorCorrectionLevel: 'M' })

    expect(Buffer.byteLength(json)).toBe(MAX_PAIRING_OFFER_JSON_BYTES)
    expect(qr.modules.size).toBeLessThanOrEqual(109)
  })
})

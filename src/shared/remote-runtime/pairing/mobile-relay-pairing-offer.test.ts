import { describe, expect, it } from 'vitest'
import { createPairingOfferSchema } from './mobile-relay-pairing-offer'
import { createMobileRelayPairingFixtures } from '../relay/mobile-relay-pairing-fixtures'

describe('desktop mobile-relay pairing contract', () => {
  const now = Date.UTC(2026, 6, 12, 16)
  const schema = createPairingOfferSchema(() => now)
  const directOffer = {
    v: 2,
    endpoint: 'ws://192.168.1.10:6768',
    deviceToken: 'device-token',
    publicKeyB64: 'legacy-public-key'
  }
  const endpointId = 'a'.repeat(64)

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

  it.each([
    'https://relay.example',
    'https://aps1-1.relay.n0.iroh.link./',
    'https://custom.example:8443/',
    'https://[2001:db8::1]:8443/'
  ])('preserves an HTTPS relay origin and native socket hints (%s)', (relayUrl) => {
    const offer = {
      ...directOffer,
      iroh: {
        endpointId,
        relayUrl,
        directAddresses: [
          '192.168.1.9:41234',
          '203.0.113.5:65535',
          '[2001:db8::1]:443',
          '[fe80::1%3]:41234',
          '[fe80::1%4294967295]:41234',
          '[::ffff:192.0.2.1]:443',
          '[::ffff:192.0.2.1%3]:443',
          '[::1]:0'
        ]
      }
    }

    expect(schema.parse(offer)).toEqual(offer)
  })

  it.each([
    '',
    'not a URL',
    'http://relay.example/',
    'wss://relay.example/',
    'https://user:secret@relay.example/',
    'https://relay.example/relay',
    'https://relay.example/../',
    'https://relay.example/?token=secret',
    'https://relay.example/#secret',
    'https://relay.example\\other',
    ' https://relay.example/',
    'https://relay .example/',
    'https://relay.example:',
    'https://relay.example:0/',
    'https://relay.example:65536/',
    'https://[:::1]/'
  ])('rejects malformed or non-origin relay hints (%j)', (relayUrl) => {
    expect(schema.safeParse({ ...directOffer, iroh: { endpointId, relayUrl } }).success).toBe(false)
  })

  it.each([
    '',
    'relay.example:443',
    '256.1.2.3:443',
    '01.2.3.4:443',
    '127.1:443',
    '127.0.0.1',
    '127.0.0.1:',
    '127.0.0.1:-1',
    '127.0.0.1:65536',
    '127.0.0.1:1.5',
    'http://127.0.0.1:443',
    '127.0.0.1:443/path',
    '::1:443',
    '[::1]',
    '[:::1]:443',
    '[2001:db8::gg]:443',
    '[1:2:3:4:5:6:7:8:9]:443',
    '[fe80::1%eth0]:443',
    '[fe80::1%4294967296]:443',
    '[::ffff:192.0.2.256]:443',
    '[127.0.0.1]:443',
    ' 127.0.0.1:443'
  ])('rejects non-IP or malformed socket hints (%j)', (address) => {
    expect(
      schema.safeParse({
        ...directOffer,
        iroh: { endpointId, directAddresses: [address] }
      }).success
    ).toBe(false)
  })

  it('retains the 64-hex, 2048-character relay, 64-character socket and eight-address limits', () => {
    const iroh = {
      endpointId,
      relayUrl: `https://${'a'.repeat(2040)}`,
      directAddresses: Array<string>(8).fill('192.168.1.9:41234')
    }
    expect(schema.parse({ ...directOffer, iroh }).iroh).toEqual(iroh)
    for (const invalid of [
      { ...iroh, endpointId: 'a'.repeat(63) },
      { ...iroh, endpointId: 'a'.repeat(65) },
      { ...iroh, endpointId: 'A'.repeat(64) },
      { ...iroh, relayUrl: `${iroh.relayUrl}a` },
      { ...iroh, directAddresses: Array<string>(9).fill('192.168.1.9:41234') }
    ]) {
      expect(schema.safeParse({ ...directOffer, iroh: invalid }).success).toBe(false)
    }
    const oversizedSocket = schema.safeParse({
      ...directOffer,
      iroh: { endpointId, directAddresses: ['a'.repeat(65)] }
    })
    expect(oversizedSocket.success).toBe(false)
    if (!oversizedSocket.success) {
      expect(oversizedSocket.error.issues).toContainEqual(
        expect.objectContaining({
          code: 'too_big',
          path: ['iroh', 'directAddresses', 0],
          maximum: 64
        })
      )
    }
  })
})

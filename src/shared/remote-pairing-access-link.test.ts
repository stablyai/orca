import { describe, expect, it } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from './pairing'
import { parseHostAccessLink } from './remote-pairing-access-link'

function accessLink(endpoint: string): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'token',
    publicKeyB64: 'key',
    scope: 'runtime'
  })
}

describe('host access link parsing', () => {
  it('extracts a sanitized display endpoint without credentials', () => {
    expect(parseHostAccessLink(accessLink('wss://orca.example.com/runtime'))).toEqual({
      ok: true,
      value: {
        pairing: expect.objectContaining({ endpoint: 'wss://orca.example.com/runtime' }),
        displayEndpoint: 'orca.example.com',
        endpointKind: 'public'
      }
    })
  })

  it('keeps IPv6 brackets in the display endpoint', () => {
    const result = parseHostAccessLink(accessLink('ws://[fd7a:115c:a1e0::1]:6768'))
    expect(result.ok && result.value.displayEndpoint).toBe('[fd7a:115c:a1e0::1]:6768')
  })

  it('rejects invalid and unsupported endpoints', () => {
    expect(parseHostAccessLink('not-a-link')).toMatchObject({
      ok: false,
      kind: 'invalid-input'
    })
    expect(parseHostAccessLink(accessLink('https://orca.example.com'))).toMatchObject({
      ok: false,
      kind: 'unsupported-destination'
    })
    expect(parseHostAccessLink(accessLink('wss://orca.example.com/#fragment'))).toMatchObject({
      ok: false,
      kind: 'unsupported-destination'
    })
    expect(parseHostAccessLink(accessLink('ws://[::ffff:0.0.0.0]:6768'))).toMatchObject({
      ok: false,
      kind: 'non-connectable-destination'
    })
    expect(parseHostAccessLink(accessLink('wss://orca.example.com:0'))).toMatchObject({
      ok: false,
      kind: 'non-connectable-destination'
    })
  })

  it('blocks absolute localhost names used in access links', () => {
    expect(parseHostAccessLink(accessLink('ws://localhost.:6768'))).toMatchObject({
      ok: true,
      value: { endpointKind: 'loopback' }
    })
    expect(parseHostAccessLink(accessLink('ws://api.localhost.:6768'))).toMatchObject({
      ok: true,
      value: { endpointKind: 'loopback' }
    })
  })

  it('rejects mobile-only access grants', () => {
    const link = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'wss://orca.example.com',
      deviceToken: 'token',
      publicKeyB64: 'key',
      scope: 'mobile'
    })
    expect(parseHostAccessLink(link)).toMatchObject({ ok: false, kind: 'mobile-only' })
  })
})

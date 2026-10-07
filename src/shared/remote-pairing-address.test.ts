import { describe, expect, it } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from './pairing'
import {
  classifyRemotePairingHostname,
  hostAccessLinkNeedsTunnel,
  parseHostAccessLink
} from './remote-pairing-address'

function accessLink(endpoint: string): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'token',
    publicKeyB64: 'key',
    scope: 'runtime'
  })
}

describe('remote pairing address', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['localhost', 'loopback'],
    ['localhost.', 'loopback'],
    ['api.localhost', 'loopback'],
    ['api.localhost.', 'loopback'],
    ['localhost.localdomain', 'loopback'],
    ['localhost6', 'loopback'],
    ['ip6-localhost', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['100.76.32.125', 'tailscale'],
    ['::ffff:644c:207d', 'tailscale'],
    ['192.168.1.20', 'lan'],
    ['10.0.0.8', 'lan'],
    ['fd7a:115c:a1e0::1', 'lan'],
    ['fe80::1', 'lan'],
    ['orca.example.com', 'public'],
    ['devbox', 'custom']
  ] as const)('classifies %s as %s', (hostname, expected) => {
    expect(classifyRemotePairingHostname(hostname)).toBe(expected)
  })

  it('extracts a sanitized display endpoint without credentials', () => {
    expect(parseHostAccessLink(accessLink('wss://orca.example.com/runtime'))).toEqual({
      ok: true,
      value: {
        pairing: expect.objectContaining({ endpoint: 'wss://orca.example.com/runtime' }),
        displayEndpoint: 'orca.example.com',
        endpointKind: 'public',
        viaRelay: false
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

  it('lets a Relay link reach a loopback endpoint without an SSH tunnel', () => {
    const link = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
      scope: 'runtime',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay-c1.onorca.dev',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'A'.repeat(43),
        inviteExpiresAt: Date.now() + 60_000,
        e2eeFraming: 2
      }
    })
    const relayLink = parseHostAccessLink(link)
    const directLink = parseHostAccessLink(accessLink('ws://127.0.0.1:6768'))
    if (!relayLink.ok || !directLink.ok) {
      throw new Error('expected both access links to parse')
    }

    expect(relayLink.value).toMatchObject({ endpointKind: 'loopback', viaRelay: true })
    expect(hostAccessLinkNeedsTunnel(relayLink.value)).toBe(false)
    expect(hostAccessLinkNeedsTunnel(directLink.value)).toBe(true)
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

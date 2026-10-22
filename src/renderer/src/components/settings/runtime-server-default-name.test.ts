import { describe, expect, it } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { defaultServerNameForAccessLink } from './runtime-server-default-name'

function link(endpoint: string): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'token',
    publicKeyB64: 'key',
    scope: 'runtime'
  })
}

describe('default server name', () => {
  it('uses the host when nothing else is called that', () => {
    expect(defaultServerNameForAccessLink(link('ws://100.76.32.125:6768'))).toBe('100.76.32.125')
  })

  it('adds the port when a server on the same host already took the bare name', () => {
    expect(
      defaultServerNameForAccessLink(link('ws://127.0.0.1:7002'), [{ name: '127.0.0.1' }])
    ).toBe('127.0.0.1:7002')
  })

  it('numbers the name when host and host:port are both taken', () => {
    expect(
      defaultServerNameForAccessLink(link('ws://100.76.32.125:6768'), [
        { name: '100.76.32.125' },
        { name: '100.76.32.125:6768' }
      ])
    ).toBe('100.76.32.125 (2)')
  })

  it('returns nothing for an invalid link', () => {
    expect(defaultServerNameForAccessLink('not-a-link')).toBe('')
  })
})

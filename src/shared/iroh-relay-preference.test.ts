import { describe, expect, it } from 'vitest'
import { parseIrohRelayUrl } from './iroh-relay-preference'

describe('Iroh home relay preference', () => {
  it.each([null, undefined, '', '   '])(
    'keeps Automatic distinct from an explicit relay (%j)',
    (value) => {
      expect(parseIrohRelayUrl(value)).toBeNull()
    }
  )

  it.each([
    [' https://relay.example:443/ ', 'https://relay.example/'],
    ['HTTPS://RELAY.EXAMPLE:8443', 'https://relay.example:8443/'],
    ['https://aps1-1.relay.n0.iroh.link./', 'https://aps1-1.relay.n0.iroh.link./'],
    ['https://[::1]:8443/', 'https://[::1]:8443/']
  ])('normalizes a valid relay without changing its origin (%s)', (value, expected) => {
    expect(parseIrohRelayUrl(value)).toBe(expected)
  })

  it.each([
    false,
    1,
    'http://relay.example/',
    'wss://relay.example/',
    'https://user:secret@relay.example/',
    'https://relay.example/relay',
    'https://relay.example/../',
    'https://relay.example/?token=secret',
    'https://relay.example/#secret',
    'https://relay.example\\other',
    'https://relay .example/',
    'https://relay.example:',
    'https://relay.example:0/',
    'https://relay.example:65536/'
  ])('rejects malformed or secret-bearing input instead of falling back (%j)', (value) => {
    let failure: unknown
    try {
      parseIrohRelayUrl(value)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('secret')
    if (typeof value === 'string') {
      expect(String(failure)).not.toContain(value)
    }
  })
})

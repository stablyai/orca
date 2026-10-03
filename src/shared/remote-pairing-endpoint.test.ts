import { describe, expect, it } from 'vitest'
import { classifyRemotePairingHostname, displayableEndpoint } from './remote-pairing-endpoint'

describe('remote pairing endpoint', () => {
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
    ['devbox', 'custom'],
    // Why: four hex characters are a hostname, not a ULA hextet — see remote-runtime-tailscale-hint.
    ['fdab', 'custom'],
    ['fe80', 'custom'],
    ['fdab.example.com', 'public']
  ] as const)('classifies %s as %s', (hostname, expected) => {
    expect(classifyRemotePairingHostname(hostname)).toBe(expected)
  })

  it('shows scheme and host only, and nothing at all when the host is unsafe to print', () => {
    expect(displayableEndpoint('wss://user:s3cret@desk.example.com:6768/p?token=abc')).toBe(
      'wss://desk.example.com:6768'
    )
    // Why: consumers substring-match messages for verdict tokens such as `terminal_gone`.
    expect(displayableEndpoint('ws://terminal_gone.example:6768')).toBeNull()
    expect(displayableEndpoint('192.168.1.20:6768')).toBeNull()
  })

  it('renders an IPv4-mapped IPv6 literal as the dotted quad the user pasted', () => {
    // WHATWG URL recompresses this to `[::ffff:6440:5]`, which names nothing actionable.
    expect(displayableEndpoint('ws://[::ffff:100.64.0.5]:6768')).toBe('ws://100.64.0.5:6768')
    expect(displayableEndpoint('ws://[fd7a:115c:a1e0::1]:6768')).toBe(
      'ws://[fd7a:115c:a1e0::1]:6768'
    )
  })
})

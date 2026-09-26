import { describe, expect, it } from 'vitest'
import {
  isTailscaleEndpoint,
  withRemoteRuntimeTailscaleHint
} from './remote-runtime-tailscale-hint'

const UNREACHABLE = 'Could not connect to the remote Orca runtime.'
const LAN_TAIL =
  "If this device is not on the server's network it cannot reach it — re-pair with an address it can reach, such as the server's Tailscale address (100.x or a *.ts.net name); see https://tailscale.com/download. Otherwise check that the server is awake and not firewalling the port."

describe('isTailscaleEndpoint', () => {
  it('matches MagicDNS hostnames', () => {
    expect(isTailscaleEndpoint('wss://example-host.tailnet.ts.net')).toBe(true)
    expect(isTailscaleEndpoint('ws://host.ts.net:6768')).toBe(true)
  })

  it('matches the 100.64.0.0/10 CGNAT range', () => {
    expect(isTailscaleEndpoint('ws://100.64.0.5:6768')).toBe(true)
    expect(isTailscaleEndpoint('ws://100.127.255.255:6768')).toBe(true)
  })

  it('matches Tailscale IPv6 (fd7a:115c:a1e0::/48) literals', () => {
    // Pairing endpoints can carry a bracketed IPv6 literal (resolvePairingEndpoint).
    expect(isTailscaleEndpoint('wss://[fd7a:115c:a1e0::1]:443')).toBe(true)
    expect(isTailscaleEndpoint('ws://[fd7a:115c:a1e0:ab12:4843:cd96:626b:1]:6768')).toBe(true)
    expect(isTailscaleEndpoint('ws://[2001:db8::1]:6768')).toBe(false)
    expect(isTailscaleEndpoint('ws://[::1]:6768')).toBe(false)
  })

  it('rejects non-Tailscale hosts and the surrounding 100.x space', () => {
    expect(isTailscaleEndpoint('ws://192.168.1.10:6768')).toBe(false)
    expect(isTailscaleEndpoint('wss://orca.example.com')).toBe(false)
    expect(isTailscaleEndpoint('ws://100.63.0.1:6768')).toBe(false)
    expect(isTailscaleEndpoint('ws://100.128.0.1:6768')).toBe(false)
    expect(isTailscaleEndpoint('ws://notts.net.evil.com')).toBe(false)
    // A DNS name that merely starts with a CGNAT-shaped label is not a TS IP.
    expect(isTailscaleEndpoint('ws://100.64.0.1.example.com:6768')).toBe(false)
  })

  it('handles bare hosts without a scheme and empty input', () => {
    expect(isTailscaleEndpoint('host.ts.net')).toBe(true)
    // A trailing-dot FQDN is still the same tailnet host.
    expect(isTailscaleEndpoint('wss://host.ts.net.')).toBe(true)
    expect(isTailscaleEndpoint('')).toBe(false)
    expect(isTailscaleEndpoint(null)).toBe(false)
    expect(isTailscaleEndpoint(undefined)).toBe(false)
  })
})

describe('withRemoteRuntimeTailscaleHint', () => {
  it('recommends switching to Tailscale when the endpoint is not on a tailnet', () => {
    const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, 'wss://orca.example.com')
    expect(result).toContain('Could not connect to the remote Orca runtime')
    expect(result).toContain('connect both devices to Tailscale')
    expect(result).toContain('https://tailscale.com/download')
  })

  it('points at tailnet-specific causes when the endpoint is already Tailscale', () => {
    const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, 'wss://example-host.tailnet.ts.net')
    expect(result).toContain('Funnel reverted to tailnet-only')
    expect(result).toContain('already-paired devices reconnect with their saved token')
    expect(result).not.toContain('https://tailscale.com/download')
  })

  it('covers the close and timeout failure variants', () => {
    expect(
      withRemoteRuntimeTailscaleHint(
        'Remote Orca runtime closed the connection.',
        'wss://orca.example.com'
      )
    ).toContain('connect both devices to Tailscale')
    expect(
      withRemoteRuntimeTailscaleHint(
        'Timed out while connecting to the remote Orca runtime.',
        'wss://host.ts.net'
      )
    ).toContain('Funnel reverted to tailnet-only')
  })

  it('leaves non-connectivity errors untouched', () => {
    const auth = 'Remote Orca runtime rejected the pairing token.'
    expect(withRemoteRuntimeTailscaleHint(auth, 'ws://192.168.1.10:6768')).toBe(auth)
  })

  it('is idempotent — does not append the hint or endpoint twice', () => {
    for (const endpoint of ['ws://192.168.1.10:6768', 'ws://100.64.0.5:6768', 'wss://a.example']) {
      const once = withRemoteRuntimeTailscaleHint(UNREACHABLE, endpoint)
      expect(withRemoteRuntimeTailscaleHint(once, endpoint)).toBe(once)
    }
  })

  // Why: #14210 — a LAN pairing address failed from a device on the same tailnet, and the
  // hint blamed Tailscale instead of naming the unreachable address.
  it('names a LAN endpoint and does not blame Tailscale', () => {
    const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://192.168.1.20:6768')
    expect(result).toBe(
      "Could not connect to the remote Orca runtime at ws://192.168.1.20:6768. That is a local-network address. If this device is not on the server's network it cannot reach it — re-pair with an address it can reach, such as the server's Tailscale address (100.x or a *.ts.net name); see https://tailscale.com/download. Otherwise check that the server is awake and not firewalling the port."
    )
    expect(result).not.toContain('connect both devices to Tailscale')
    expect(withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://[fe80::1]:6768')).toContain(
      'local-network address'
    )
  })

  // Why: the LAN hint must not assert a cause the client cannot check. A routed VPN reaches
  // 192.168.x.x, and a same-network failure is usually a sleeping or firewalled host — and a
  // user who is not on a tailnet at all still needs the download pointer.
  it('keeps the LAN hint conditional and keeps the Tailscale download link', () => {
    const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://10.0.0.8:6768')
    expect(result).toContain("If this device is not on the server's network it cannot reach it")
    expect(result).toContain('https://tailscale.com/download')
    expect(result).toContain('check that the server is awake and not firewalling the port')
    expect(result).not.toContain('only works from')
  })

  // Why: the hint opens with a subject. When nothing safe could be printed there is no address
  // for "That" to point at, so the sentence has to name the subject itself.
  it('keeps the LAN hint readable when no endpoint could be shown', () => {
    const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, '192.168.1.20:6768')
    expect(result).toBe(`${UNREACHABLE} The paired address is a local-network address. ${LAN_TAIL}`)
  })

  it('gives an IPv4-mapped IPv6 tailnet endpoint the tailnet hint and a readable address', () => {
    const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://[::ffff:100.64.0.5]:6768')
    expect(result).toContain('offline on your tailnet')
    expect(result).not.toContain('connect both devices to Tailscale')
    // Why: WHATWG URL recompresses the literal to `[::ffff:6440:5]`, which names nothing a user
    // can act on.
    expect(result).toContain('at ws://100.64.0.5:6768')
    expect(result).not.toContain('6440')
  })

  // Why: a schemeless or unparseable endpoint used to reach the classifier through a regex
  // fallback that had already chopped the host apart, so a plain hostname and a bare bracketed
  // tailnet literal both came out as "local-network".
  it('classifies only a host it could really extract', () => {
    // `fdab` is a four-hex-character hostname, not a ULA hextet.
    expect(withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://fdab:6768')).toContain(
      'connect both devices to Tailscale'
    )
    for (const endpoint of ['[fd7a:115c:a1e0::1]:6768', 'ws://[fd7a:115c:a1e0::1]:6768']) {
      const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, endpoint)
      expect(result).toContain('offline on your tailnet')
      expect(result).not.toContain('local-network address')
    }
  })

  it('names a tailnet endpoint alongside the tailnet hint', () => {
    const result = withRemoteRuntimeTailscaleHint(
      'Timed out waiting for the remote Orca runtime to respond.',
      'ws://100.64.0.5:6768/path?token=abc'
    )
    expect(result).toMatch(
      /^Timed out waiting for the remote Orca runtime to respond at ws:\/\/100\.64\.0\.5:6768\. The server may be offline on your tailnet/
    )
    expect(result).not.toContain('token=abc')
  })

  it('keeps the other-network hint for public and loopback endpoints', () => {
    for (const endpoint of ['wss://orca.example.com', 'ws://127.0.0.1:6768', 'ws://devbox:6768']) {
      const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, endpoint)
      expect(result).toContain('connect both devices to Tailscale')
      expect(result).toContain(`at ${endpoint}`)
    }
  })

  it('does not repeat an endpoint the message already names', () => {
    const message =
      'Could not connect to the remote Orca runtime at ws://192.168.1.20:6768: the host did not answer, so anything running on it is unverifiable.'
    const result = withRemoteRuntimeTailscaleHint(message, 'ws://192.168.1.20:6768')
    expect(result.startsWith(`${message} That is a local-network address`)).toBe(true)
    expect(result.split('192.168.1.20').length - 1).toBe(1)
  })

  // Why: the dedupe used to be a bare substring check, so a message naming a longer host that
  // starts with the dialed one would have swallowed the address.
  it('still names an endpoint that is only a prefix of the one already in the message', () => {
    const message = 'Could not connect to the remote Orca runtime at ws://a.example.com.'
    expect(withRemoteRuntimeTailscaleHint(message, 'ws://a.example')).toContain(
      'at ws://a.example.com at ws://a.example.'
    )
  })

  it('shows only a sanitized endpoint, and none at all when nothing is safe to show', () => {
    const withUserinfo = withRemoteRuntimeTailscaleHint(
      UNREACHABLE,
      'wss://user:s3cret@desk.example.com:6768/p'
    )
    expect(withUserinfo).toContain('at wss://desk.example.com:6768')
    expect(withUserinfo).not.toContain('s3cret')
    // Why: a placeholder such as "the paired endpoint" names nothing; omit the clause instead.
    const smuggled = withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://terminal_gone.example:6768')
    expect(smuggled).toBe(
      'Could not connect to the remote Orca runtime. If the server is on another network, connect both devices to Tailscale and pair using its Tailscale address (100.x or a *.ts.net name). See https://tailscale.com/download.'
    )
    expect(smuggled).not.toContain('terminal_gone')
  })

  it('adds no endpoint when none is known', () => {
    expect(withRemoteRuntimeTailscaleHint(UNREACHABLE, null)).toMatch(
      /^Could not connect to the remote Orca runtime\. If the server is on another network/
    )
  })

  it('passes non-connectivity errors through unchanged, endpoint included', () => {
    const auth = 'Remote Orca runtime rejected the pairing token.'
    expect(withRemoteRuntimeTailscaleHint(auth, 'ws://100.64.0.5:6768')).toBe(auth)
    expect(withRemoteRuntimeTailscaleHint(auth, null)).toBe(auth)
  })
})

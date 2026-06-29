import { describe, expect, it } from 'vitest'
import {
  isTailscaleEndpoint,
  withRemoteRuntimeTailscaleHint
} from './remote-runtime-tailscale-hint'

const UNREACHABLE = 'Could not connect to the remote Orca runtime.'

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
    const result = withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://192.168.1.10:6768')
    expect(result).toContain(UNREACHABLE)
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
        'ws://192.168.1.10:6768'
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

  it('is idempotent — does not append the hint twice', () => {
    const once = withRemoteRuntimeTailscaleHint(UNREACHABLE, 'ws://192.168.1.10:6768')
    const twice = withRemoteRuntimeTailscaleHint(once, 'ws://192.168.1.10:6768')
    expect(twice).toBe(once)
  })
})

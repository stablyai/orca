import { describe, expect, it } from 'vitest'
import {
  formatCloudflaredQuickTunnelCommand,
  isCloudflareQuickTunnelAddress,
  parseCloudflareTunnelAddress
} from './cloudflare-tunnel-address'
import { webSocketEndpointPort } from './pairing-url'

describe('parseCloudflareTunnelAddress', () => {
  it('accepts the https URL cloudflared prints and converts it to wss', () => {
    expect(parseCloudflareTunnelAddress('https://tidy-otter-plum.trycloudflare.com')).toEqual({
      ok: true,
      value: 'wss://tidy-otter-plum.trycloudflare.com'
    })
  })

  it('drops the trailing slash a browser copy adds', () => {
    expect(parseCloudflareTunnelAddress('https://tidy-otter-plum.trycloudflare.com/')).toEqual({
      ok: true,
      value: 'wss://tidy-otter-plum.trycloudflare.com'
    })
  })

  // Why: a bare host would inherit the bound local port and advertise :6768 through an edge on 443.
  it('adds wss:// to a bare hostname instead of leaving it portless', () => {
    expect(parseCloudflareTunnelAddress('orca.example.com')).toEqual({
      ok: true,
      value: 'wss://orca.example.com'
    })
  })

  it('accepts a named tunnel hostname with a path', () => {
    expect(parseCloudflareTunnelAddress('https://orca.example.com/orca')).toEqual({
      ok: true,
      value: 'wss://orca.example.com/orca'
    })
  })

  it('accepts wss:// verbatim', () => {
    expect(parseCloudflareTunnelAddress('wss://orca.example.com').ok).toBe(true)
  })

  // Why: normalizePairingUrl maps http: to ws:, so without an explicit scheme check a pasted
  // http:// address would ship pairing traffic to a public host in cleartext.
  it('rejects schemes that would reach a public host unencrypted', () => {
    expect(parseCloudflareTunnelAddress('http://orca.example.com').ok).toBe(false)
    expect(parseCloudflareTunnelAddress('ws://orca.example.com').ok).toBe(false)
    expect(parseCloudflareTunnelAddress('http://tidy-otter-plum.trycloudflare.com').ok).toBe(false)
  })

  it('trims surrounding whitespace', () => {
    expect(parseCloudflareTunnelAddress('  https://orca.example.com  ').ok).toBe(true)
  })

  // Why: these all mint a link only reachable from inside the network, which defeats the tunnel.
  it('rejects loopback, tailnet, and LAN destinations', () => {
    for (const bad of [
      'https://127.0.0.1:6768',
      'http://localhost:6768',
      '127.0.0.1',
      'localhost',
      'https://192.168.1.50',
      '10.0.0.4',
      '100.76.32.125'
    ]) {
      expect(parseCloudflareTunnelAddress(bad).ok, bad).toBe(false)
    }
  })

  it('rejects empty, malformed, and credential-bearing input', () => {
    for (const bad of [
      '',
      '   ',
      'has space',
      'wss://',
      'https://user:password@orca.example.com',
      'https://orca.example.com#fragment',
      'https://0.0.0.0',
      'ftp://orca.example.com',
      'single-label-host'
    ]) {
      expect(parseCloudflareTunnelAddress(bad).ok, bad).toBe(false)
    }
  })
})

describe('isCloudflareQuickTunnelAddress', () => {
  it('flags quick tunnels whose hostname is regenerated on restart', () => {
    expect(isCloudflareQuickTunnelAddress('https://tidy-otter-plum.trycloudflare.com')).toBe(true)
  })

  it('does not flag a named tunnel or invalid input', () => {
    expect(isCloudflareQuickTunnelAddress('https://orca.example.com')).toBe(false)
    expect(isCloudflareQuickTunnelAddress('not a host')).toBe(false)
  })
})

describe('formatCloudflaredQuickTunnelCommand', () => {
  it('targets the bound loopback port', () => {
    expect(formatCloudflaredQuickTunnelCommand(6768)).toBe(
      'cloudflared tunnel --url http://127.0.0.1:6768'
    )
  })

  // Why: the listener may report a wildcard host after a network widen, but cloudflared runs beside
  // the runtime, so the command must always dial loopback.
  it('always dials loopback, never the bound wildcard host', () => {
    expect(formatCloudflaredQuickTunnelCommand(webSocketEndpointPort('ws://0.0.0.0:6768')!)).toBe(
      'cloudflared tunnel --url http://127.0.0.1:6768'
    )
  })
})

describe('webSocketEndpointPort', () => {
  it('reads the port from a bound endpoint', () => {
    expect(webSocketEndpointPort('ws://127.0.0.1:6768')).toBe(6768)
  })

  it('returns null for a missing, portless, or malformed endpoint', () => {
    expect(webSocketEndpointPort(null)).toBeNull()
    expect(webSocketEndpointPort('wss://orca.example.com')).toBeNull()
    expect(webSocketEndpointPort('not-a-url')).toBeNull()
  })
})

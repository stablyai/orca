import { describe, expect, it } from 'vitest'
import { parseMobilePairingEndpoint } from './mobile-pairing-endpoint'

describe('parseMobilePairingEndpoint', () => {
  it('preserves existing address forms', () => {
    expect(parseMobilePairingEndpoint('192.168.1.24')).toEqual({
      ok: true,
      endpoint: '192.168.1.24'
    })
    expect(parseMobilePairingEndpoint('my-mac.ts.net')).toEqual({
      ok: true,
      endpoint: 'my-mac.ts.net'
    })
    expect(parseMobilePairingEndpoint('home.example.com:8443')).toEqual({
      ok: true,
      endpoint: 'home.example.com:8443'
    })
  })

  it('accepts WebSocket origins for public tunnels', () => {
    expect(parseMobilePairingEndpoint('wss://orca.example.com')).toEqual({
      ok: true,
      endpoint: 'wss://orca.example.com'
    })
    expect(parseMobilePairingEndpoint('ws://private-host:6768/')).toEqual({
      ok: true,
      endpoint: 'ws://private-host:6768'
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseMobilePairingEndpoint('  wss://orca.example.com  ')).toEqual({
      ok: true,
      endpoint: 'wss://orca.example.com'
    })
  })

  it('rejects unsupported schemes and WebSocket credentials', () => {
    for (const value of [
      'https://orca.example.com',
      'ftp://orca.example.com',
      'wss://user@orca.example.com',
      'wss://user:secret@orca.example.com'
    ]) {
      expect(parseMobilePairingEndpoint(value).ok).toBe(false)
    }
  })

  it('rejects paths, queries, and fragments', () => {
    for (const value of [
      'wss://orca.example.com/orca',
      'wss://orca.example.com?token=value',
      'wss://orca.example.com#fragment'
    ]) {
      expect(parseMobilePairingEndpoint(value).ok).toBe(false)
    }
  })

  it('rejects invalid ports and coercive numeric hosts', () => {
    for (const value of [
      'wss://orca.example.com:0',
      'wss://orca.example.com:65536',
      'wss://127.1',
      'wss://foo.123',
      'wss://[::1]:6768'
    ]) {
      expect(parseMobilePairingEndpoint(value).ok).toBe(false)
    }
  })
})

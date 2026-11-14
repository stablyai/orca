import { describe, expect, it } from 'vitest'
import { isLinkLocalAddress, isLinkLocalEndpoint } from './link-local-address'

describe('isLinkLocalAddress', () => {
  it('matches IPv4 169.254.0.0/16 and IPv6 fe80::/10, including scoped and mapped forms', () => {
    for (const address of [
      '169.254.0.1',
      '169.254.83.107',
      '169.254.255.255',
      'fe80::1',
      'FE80::abcd%12',
      'febf::1',
      '[fe80::1]',
      '::ffff:169.254.10.20',
      '::ffff:a9fe:a14'
    ]) {
      expect(isLinkLocalAddress(address), address).toBe(true)
    }
  })

  it('keeps LAN, Tailscale, loopback, public and hostnames dialable', () => {
    for (const address of [
      '192.168.1.20',
      '10.0.0.5',
      '172.16.4.2',
      '100.101.102.103',
      '127.0.0.1',
      '169.253.1.1',
      '169.255.1.1',
      '8.8.8.8',
      'fd7a:115c:a1e0::1',
      'fec0::1',
      '::1',
      '::ffff:192.168.1.2',
      '169.254.1',
      '169.254.1.999',
      'desktop.local',
      ''
    ]) {
      expect(isLinkLocalAddress(address), address).toBe(false)
    }
  })
})

describe('isLinkLocalEndpoint', () => {
  it('classifies the WebSocket URL hostname', () => {
    expect(isLinkLocalEndpoint('ws://169.254.83.107:6768')).toBe(true)
    expect(isLinkLocalEndpoint('ws://[fe80::1]:6768')).toBe(true)
    expect(isLinkLocalEndpoint('ws://[::ffff:169.254.1.2]:6768')).toBe(true)
    expect(isLinkLocalEndpoint('ws://192.168.1.20:6768')).toBe(false)
    expect(isLinkLocalEndpoint('wss://desktop.example.ts.net')).toBe(false)
    expect(isLinkLocalEndpoint('not a url')).toBe(false)
  })
})

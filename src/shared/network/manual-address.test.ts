import { describe, it, expect } from 'vitest'
import { parseManualNetworkAddress } from './manual-address'

describe('parseManualNetworkAddress', () => {
  describe('IPv4', () => {
    it('accepts canonical IPv4', () => {
      expect(parseManualNetworkAddress('192.168.1.24')).toEqual({
        ok: true,
        address: '192.168.1.24'
      })
      expect(parseManualNetworkAddress('100.64.1.20')).toEqual({
        ok: true,
        address: '100.64.1.20'
      })
    })

    it('accepts boundary IPv4 values', () => {
      expect(parseManualNetworkAddress('0.0.0.0').ok).toBe(true)
      expect(parseManualNetworkAddress('255.255.255.255').ok).toBe(true)
    })

    it('rejects malformed IPv4', () => {
      for (const bad of ['', '   ', '1.2.3', '1.2.3.4.5', '256.0.0.1']) {
        expect(parseManualNetworkAddress(bad)).toEqual({
          ok: false,
          error: 'Enter an IPv4 address or Tailscale MagicDNS hostname'
        })
      }
    })

    it('rejects leading zeros in octets', () => {
      expect(parseManualNetworkAddress('01.02.03.04')).toEqual({
        ok: false,
        error: 'Enter an IPv4 address or Tailscale MagicDNS hostname'
      })
      expect(parseManualNetworkAddress('0.0.0.0').ok).toBe(true)
    })
  })

  describe('Tailscale MagicDNS hostname', () => {
    it('accepts short MagicDNS names', () => {
      expect(parseManualNetworkAddress('my-mac.ts.net')).toEqual({
        ok: true,
        address: 'my-mac.ts.net'
      })
    })

    it('accepts tailnet-qualified MagicDNS names', () => {
      expect(parseManualNetworkAddress('my-mac.tail-abcd.ts.net')).toEqual({
        ok: true,
        address: 'my-mac.tail-abcd.ts.net'
      })
      expect(parseManualNetworkAddress('a.b.c.d.ts.net').ok).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(parseManualNetworkAddress('MY-MAC.TS.NET').ok).toBe(true)
    })

    it('rejects non-Tailscale hostnames', () => {
      for (const bad of ['my-mac', 'my-mac.ts.com', '-foo.ts.net', 'my-mac.com']) {
        expect(parseManualNetworkAddress(bad).ok).toBe(false)
      }
    })
  })

  describe('length and whitespace', () => {
    it('rejects inputs longer than 253 chars', () => {
      const long = `${'a'.repeat(250)}.ts.net`
      expect(long.length).toBeGreaterThan(253)
      expect(parseManualNetworkAddress(long).ok).toBe(false)
    })

    it('trims leading and trailing whitespace before validating', () => {
      expect(parseManualNetworkAddress('  192.168.1.24  ')).toEqual({
        ok: true,
        address: '192.168.1.24'
      })
    })
  })
})

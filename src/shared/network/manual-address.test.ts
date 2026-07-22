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

    it('accepts an IPv4 address with a port suffix', () => {
      expect(parseManualNetworkAddress('192.168.1.24:8080')).toEqual({
        ok: true,
        address: '192.168.1.24:8080'
      })
    })

    it('rejects malformed IPv4', () => {
      for (const bad of ['', '   ', '1.2.3', '1.2.3.4.5', '256.0.0.1']) {
        expect(parseManualNetworkAddress(bad)).toEqual({
          ok: false,
          error: 'Enter an IPv4 address, hostname, or ws(s):// URL'
        })
      }
    })

    it('rejects leading zeros in octets', () => {
      expect(parseManualNetworkAddress('01.02.03.04')).toEqual({
        ok: false,
        error: 'Enter an IPv4 address, hostname, or ws(s):// URL'
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

    it('rejects a MagicDNS-shaped hostname with a malformed label', () => {
      // Leading/trailing hyphens are invalid in any RFC 1123 label,
      // regardless of the `.ts.net` suffix.
      expect(parseManualNetworkAddress('-foo.ts.net').ok).toBe(false)
    })
  })

  describe('arbitrary hostnames (DDNS / self-hosted domains)', () => {
    it('accepts a bare single-label hostname', () => {
      expect(parseManualNetworkAddress('my-nas')).toEqual({
        ok: true,
        address: 'my-nas'
      })
    })

    it('accepts a multi-label domain, e.g. a DDNS hostname', () => {
      expect(parseManualNetworkAddress('home.example.com')).toEqual({
        ok: true,
        address: 'home.example.com'
      })
      expect(parseManualNetworkAddress('my-house.ddns.net').ok).toBe(true)
    })

    it('accepts a hostname with a port suffix', () => {
      expect(parseManualNetworkAddress('home.example.com:8443')).toEqual({
        ok: true,
        address: 'home.example.com:8443'
      })
    })

    it('is case-insensitive', () => {
      expect(parseManualNetworkAddress('HOME.EXAMPLE.COM').ok).toBe(true)
    })

    it('rejects labels with leading or trailing hyphens', () => {
      for (const bad of ['-foo.example.com', 'foo-.example.com', 'foo..com']) {
        expect(parseManualNetworkAddress(bad).ok).toBe(false)
      }
    })

    it('rejects hostnames with characters outside the RFC 1123 grammar', () => {
      for (const bad of ['my_host.example.com', 'my host.example.com', 'example.com/path']) {
        expect(parseManualNetworkAddress(bad).ok).toBe(false)
      }
    })

    it('rejects a host whose last label is numeric as an ambiguous IPv4', () => {
      // The WHATWG URL parser downstream treats "ends in a number" as an IPv4
      // signal and would reinterpret or fail to resolve these (`123` ->
      // `0.0.0.123`; `foo.123` -> no-op fallback), so accepting one here would
      // validate an address the main process dials differently.
      const bad = [
        '123',
        '123:8080',
        '1.2.3',
        '1.2.3.4.5',
        '256.0.0.1',
        '999.999.999.999',
        'foo.123',
        'foo.123:8080',
        'foo.0x1'
      ]
      for (const value of bad) {
        expect(parseManualNetworkAddress(value).ok).toBe(false)
      }
    })

    it('still accepts a hostname whose last label merely contains digits', () => {
      // Only a fully-numeric (or hex) final label is ambiguous; a label like
      // `com` or `nas1` is a normal hostname.
      expect(parseManualNetworkAddress('host2.example.com').ok).toBe(true)
      expect(parseManualNetworkAddress('my-nas1').ok).toBe(true)
    })
  })

  describe('port suffix', () => {
    it('accepts boundary port values', () => {
      expect(parseManualNetworkAddress('example.com:1').ok).toBe(true)
      expect(parseManualNetworkAddress('example.com:65535').ok).toBe(true)
    })

    it('rejects out-of-range ports', () => {
      expect(parseManualNetworkAddress('example.com:0').ok).toBe(false)
      expect(parseManualNetworkAddress('example.com:65536').ok).toBe(false)
      expect(parseManualNetworkAddress('example.com:99999').ok).toBe(false)
    })

    it('rejects a non-numeric or empty port', () => {
      expect(parseManualNetworkAddress('example.com:abc').ok).toBe(false)
      expect(parseManualNetworkAddress('example.com:').ok).toBe(false)
    })

    it('rejects a leading-zero (non-canonical, unbounded-length) port', () => {
      expect(parseManualNetworkAddress('example.com:0080').ok).toBe(false)
      expect(parseManualNetworkAddress(`example.com:${'0'.repeat(1000)}8080`).ok).toBe(false)
    })

    it('rejects addresses with more than one colon (e.g. IPv6-shaped input)', () => {
      expect(parseManualNetworkAddress('example.com:80:90').ok).toBe(false)
      expect(parseManualNetworkAddress('::1').ok).toBe(false)
    })
  })

  describe('WebSocket URL', () => {
    it('accepts ws:// and wss:// URLs with optional ports', () => {
      expect(parseManualNetworkAddress('wss://example.com')).toEqual({
        ok: true,
        address: 'wss://example.com'
      })
      expect(parseManualNetworkAddress('wss://example.com:443')).toEqual({
        ok: true,
        address: 'wss://example.com:443'
      })
      expect(parseManualNetworkAddress('ws://example.com:8080')).toEqual({
        ok: true,
        address: 'ws://example.com:8080'
      })
    })

    it('accepts reverse-proxy paths and query strings', () => {
      expect(parseManualNetworkAddress('wss://example.com/orca?route=runtime').ok).toBe(true)
    })

    it('rejects URLs the pairing endpoint cannot advertise', () => {
      for (const bad of [
        'http://example.com',
        'wss://',
        'wss://user:secret@example.com',
        'wss://example.com/#fragment',
        'wss://example.com:0',
        'ws://0.0.0.0:8080',
        'ws://[::]:8080'
      ]) {
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

    it('rejects whitespace inside the address', () => {
      expect(parseManualNetworkAddress('my host.example.com').ok).toBe(false)
    })
  })
})

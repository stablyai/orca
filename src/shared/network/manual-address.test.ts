import { describe, it, expect } from 'vitest'
import { parseManualNetworkAddress } from './manual-address'

describe('parseManualNetworkAddress', () => {
  describe('arbitrary hostnames (DDNS / self-hosted domains)', () => {
    it('rejects a host whose last label is numeric as an ambiguous IPv4', () => {
      // WHATWG URLs reinterpret numeric endings as IPv4 (123 → 0.0.0.123) or fail; accepting them would validate a host main dials differently.
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
  })

  describe('port suffix', () => {
    it('rejects a leading-zero (non-canonical, unbounded-length) port', () => {
      expect(parseManualNetworkAddress('example.com:0080').ok).toBe(false)
      expect(parseManualNetworkAddress(`example.com:${'0'.repeat(1000)}8080`).ok).toBe(false)
    })
  })

  describe('IPv6', () => {
    it('rejects wildcard, malformed, and invalid-port IPv6 addresses', () => {
      for (const bad of [
        '::',
        '[::]:8080',
        '0:0:0:0:0:0:0:0',
        '[0:0:0:0:0:0:0:0]:8080',
        '::ffff:0.0.0.0',
        '[::ffff:0.0.0.0]:8080',
        '[::1]:0',
        '[::1]:65536',
        '[::1]:'
      ]) {
        expect(parseManualNetworkAddress(bad).ok).toBe(false)
      }
    })
  })

  describe('full URL', () => {
    it('rejects URLs the pairing endpoint cannot advertise', () => {
      for (const bad of [
        'ftp://example.com',
        'wss://',
        'wss://user:secret@example.com',
        'wss://example.com/#fragment',
        'wss://example.com:0',
        'ws://0.0.0.0:8080',
        'ws://[::]:8080',
        'ws://[0:0:0:0:0:0:0:0]:8080',
        'ws://[::ffff:0.0.0.0]:8080'
      ]) {
        expect(parseManualNetworkAddress(bad).ok).toBe(false)
      }
    })
  })
})

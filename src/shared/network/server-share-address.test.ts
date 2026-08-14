import { describe, it, expect } from 'vitest'
import { PAIRING_ENDPOINT_MAX_CHARACTERS } from '../mobile-pairing-protocol-limits'
import { parseServerShareAddress } from './server-share-address'

describe('parseServerShareAddress', () => {
  it('accepts a bare hostname or IP', () => {
    expect(parseServerShareAddress('my-host')).toEqual({ ok: true, value: 'my-host' })
    expect(parseServerShareAddress('my-mac.tail-abcd.ts.net').ok).toBe(true)
    expect(parseServerShareAddress('192.168.1.50').ok).toBe(true)
  })

  it('accepts host:port', () => {
    expect(parseServerShareAddress('192.168.1.50:6768')).toEqual({
      ok: true,
      value: '192.168.1.50:6768'
    })
    expect(parseServerShareAddress('my-host:443').ok).toBe(true)
  })

  it('accepts IPv6 literals with an optional port', () => {
    expect(parseServerShareAddress('fd7a:115c:a1e0::1').ok).toBe(true)
    expect(parseServerShareAddress('[fd7a:115c:a1e0::1]:6768').ok).toBe(true)
  })

  it('accepts ws:// and wss:// URLs', () => {
    expect(parseServerShareAddress('wss://my-host/path').ok).toBe(true)
    expect(parseServerShareAddress('ws://192.168.1.50:6768').ok).toBe(true)
  })

  it('rejects WebSocket URLs with fragments', () => {
    expect(parseServerShareAddress('wss://my-host/path#fragment').ok).toBe(false)
  })

  it('trims surrounding whitespace', () => {
    expect(parseServerShareAddress('  my-host:8080  ')).toEqual({ ok: true, value: 'my-host:8080' })
  })

  it('rejects empty, whitespace-containing, and malformed input', () => {
    for (const bad of [
      '',
      '   ',
      'has space',
      'http://my-host',
      'wss://',
      ':6768',
      '0.0.0.0',
      '::',
      'my-host:0',
      '999.999.999.999',
      'wss://user:password@my-host'
    ]) {
      expect(parseServerShareAddress(bad).ok).toBe(false)
    }
    expect(parseServerShareAddress('a'.repeat(PAIRING_ENDPOINT_MAX_CHARACTERS + 1)).ok).toBe(false)
  })

  it('rejects an out-of-range port', () => {
    expect(parseServerShareAddress('my-host:70000').ok).toBe(false)
  })
})

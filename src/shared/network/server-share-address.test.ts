import { describe, it, expect } from 'vitest'
import { PAIRING_ENDPOINT_MAX_CHARACTERS } from '../mobile-pairing-protocol-limits'
import { parseServerShareAddress } from './server-share-address'

describe('parseServerShareAddress', () => {
  it('accepts a bare hostname or IP', () => {
    expect(parseServerShareAddress('my-host')).toEqual({ ok: true, value: 'my-host' })
    expect(parseServerShareAddress('my-mac.tail-abcd.ts.net').ok).toBe(true)
    expect(parseServerShareAddress('192.168.1.50').ok).toBe(true)
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
})

import { describe, it, expect } from 'vitest'
import { isLoopbackShareAddress, parseServerShareAddress } from './server-share-address'

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

  it('accepts ws:// and wss:// URLs', () => {
    expect(parseServerShareAddress('wss://my-host/path').ok).toBe(true)
    expect(parseServerShareAddress('ws://192.168.1.50:6768').ok).toBe(true)
  })

  it('trims surrounding whitespace', () => {
    expect(parseServerShareAddress('  my-host:8080  ')).toEqual({ ok: true, value: 'my-host:8080' })
  })

  it('rejects empty, whitespace-containing, and malformed input', () => {
    for (const bad of ['', '   ', 'has space', 'http://my-host', 'wss://', ':6768']) {
      expect(parseServerShareAddress(bad).ok).toBe(false)
    }
  })

  it('rejects an out-of-range port', () => {
    expect(parseServerShareAddress('my-host:70000').ok).toBe(false)
  })
})

describe('isLoopbackShareAddress', () => {
  it('detects loopback hosts in every accepted address form', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '127.0.0.1:6768',
      'localhost',
      'LocalHost:6768',
      '::1',
      '[::1]',
      'ws://127.0.0.1:6768',
      'wss://localhost/runtime'
    ]) {
      expect(isLoopbackShareAddress(address), address).toBe(true)
    }
  })

  it('leaves routable LAN, tailnet, and public addresses alone', () => {
    for (const address of [
      '192.168.1.50',
      '100.64.0.2',
      '10.0.0.5:6768',
      'my-mac.tail-abcd.ts.net',
      'ws://100.64.0.2:6768',
      '128.0.0.1',
      '27.0.0.1',
      ''
    ]) {
      expect(isLoopbackShareAddress(address), address).toBe(false)
    }
  })
})

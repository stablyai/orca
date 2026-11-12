// Pin numeric and destination guards against operator typos/hostile director URLs that would create unintended live traffic.
import { describe, expect, it, vi } from 'vitest'
import {
  classifyPublicHttpsOrigin,
  isPublicIpAddress,
  parseBoundedInteger,
  parsePort,
  requireOrigin,
  resolvesToPublicAddress
} from './relay-bench-invocation.mjs'

/** refuse() exits the process; make that observable instead of killing the test worker. */

describe('parseBoundedInteger', () => {
  // 'Infinity' is the one that mattered: Number('Infinity') made the run loops never terminate.
  it.each(['Infinity', '-Infinity', 'NaN', '', '   ', 'abc', '1e3', '-1', '1.5', '0x10', '+2'])(
    'rejects %j',
    (value) => {
      expect(parseBoundedInteger(value, { min: 0, max: 10 })).toBeNull()
    }
  )

  it('rejects values outside the bounds', () => {
    expect(parseBoundedInteger('11', { min: 0, max: 10 })).toBeNull()
    expect(parseBoundedInteger('0', { min: 1, max: 10 })).toBeNull()
  })
})

describe('parsePort', () => {
  // WHATWG URL reads '80@attacker.example' as userinfo, so the fetch would leave loopback.
  it.each(['80@attacker.example', '0', '65536', '9222 9223', 'Infinity', ''])(
    'rejects %j',
    (value) => {
      expect(parsePort(value)).toBeNull()
    }
  )
})

describe('isPublicIpAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1'
  ])('refuses %s', (host) => {
    expect(isPublicIpAddress(host)).toBe(false)
  })

  it.each(['8.8.8.8', '172.32.0.1', '172.15.0.1', '1.1.1.1', '2001:db8::1', '::ffff:8.8.8.8'])(
    'allows %s',
    (host) => {
      expect(isPublicIpAddress(host)).toBe(true)
    }
  )
})

describe('classifyPublicHttpsOrigin', () => {
  it.each([
    ['http://relay.example', 'must be an https origin'],
    ['wss://relay.example', 'must be an https origin'],
    ['https://user:pass@relay.example', 'must not carry credentials'],
    ['https://localhost:9222', 'loopback'],
    ['https://app.localhost', 'loopback'],
    ['https://127.0.0.1:8080', 'loopback, link-local, or private'],
    ['https://[::1]/', 'loopback, link-local, or private'],
    ['https://[::ffff:127.0.0.1]/', 'loopback, link-local, or private'],
    ['https://169.254.169.254/latest/meta-data', 'loopback, link-local, or private'],
    ['https://10.1.2.3', 'loopback, link-local, or private'],
    ['not a url', 'not a URL'],
    ['', 'missing origin']
  ])('refuses %s', (value, reason) => {
    const verdict = classifyPublicHttpsOrigin(value)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain(reason)
  })
})

describe('resolvesToPublicAddress', () => {
  it('refuses when any resolved address is private', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 }
    ])
    expect((await resolvesToPublicAddress('https://relay.example', { lookup })).ok).toBe(false)
  })

  it('accepts a name that resolves publicly', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    expect(await resolvesToPublicAddress('https://relay.example', { lookup })).toEqual({ ok: true })
  })

  it('refuses when resolution fails', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))
    expect((await resolvesToPublicAddress('https://relay.example', { lookup })).ok).toBe(false)
  })
})

describe('requireOrigin and requireDirector', () => {
  it('returns the origin for an https target', () => {
    expect(requireOrigin('https://relay.example/x', 'cell origin', 'usage')).toBe(
      'https://relay.example'
    )
  })
})

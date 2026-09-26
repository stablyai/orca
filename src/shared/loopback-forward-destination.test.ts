import { describe, expect, it } from 'vitest'
import { isForwardablePort, resolveLoopbackForwardHost } from './loopback-forward-destination'

/** Admission alone; the separate suite below covers which literal gets dialled. */
function admitsForward(host: string): boolean {
  return resolveLoopbackForwardHost(host) !== null
}

describe('resolveLoopbackForwardHost admission', () => {
  it('accepts the literal loopback forms a dev server or OAuth callback binds', () => {
    expect(admitsForward('localhost')).toBe(true)
    expect(admitsForward('127.0.0.1')).toBe(true)
    expect(admitsForward('::1')).toBe(true)
    expect(admitsForward('[::1]')).toBe(true)
    expect(admitsForward('0:0:0:0:0:0:0:1')).toBe(true)
    expect(admitsForward('::ffff:127.0.0.1')).toBe(true)
  })

  it('accepts the whole 127.0.0.0/8 range, not just 127.0.0.1', () => {
    expect(admitsForward('127.0.0.53')).toBe(true)
    expect(admitsForward('127.1.2.3')).toBe(true)
    expect(admitsForward('127.255.255.255')).toBe(true)
  })

  it('normalises case, surrounding brackets and a trailing dot', () => {
    expect(admitsForward('  LocalHost ')).toBe(true)
    expect(admitsForward('localhost.')).toBe(true)
    expect(admitsForward('[::FFFF:127.0.0.1]')).toBe(true)
  })

  it('refuses names that merely start with a loopback-looking prefix', () => {
    // Regression: a `startsWith('127.')` test would admit every one of these.
    expect(admitsForward('127.evil.example.com')).toBe(false)
    expect(admitsForward('127.0.0.1.evil.example.com')).toBe(false)
    expect(admitsForward('localhost.evil.example.com')).toBe(false)
    expect(admitsForward('notlocalhost')).toBe(false)
  })

  it('refuses subdomains of localhost, whose resolution is not guaranteed', () => {
    expect(admitsForward('app.localhost')).toBe(false)
    expect(admitsForward('foo.orca.localhost')).toBe(false)
  })

  it('refuses routable, wildcard and malformed addresses', () => {
    expect(admitsForward('0.0.0.0')).toBe(false)
    expect(admitsForward('::')).toBe(false)
    expect(admitsForward('100.64.1.20')).toBe(false)
    expect(admitsForward('192.168.1.5')).toBe(false)
    expect(admitsForward('10.0.0.1')).toBe(false)
    expect(admitsForward('169.254.169.254')).toBe(false)
    expect(admitsForward('example.com')).toBe(false)
    expect(admitsForward('')).toBe(false)
    expect(admitsForward('127.0.0')).toBe(false)
    expect(admitsForward('127.0.0.256')).toBe(false)
    expect(admitsForward('127.0.0.01x')).toBe(false)
  })

  it('refuses leading-zero octets, which a resolver reads as octal or as a name', () => {
    // `127.0.0.08` is not valid octal, so getaddrinfo falls back to resolving it as a
    // hostname; `127.0.0.010` parses as 127.0.0.8, not the decimal reading. Both would
    // reach an address this check never agreed to.
    expect(admitsForward('127.0.0.08')).toBe(false)
    expect(admitsForward('127.0.0.010')).toBe(false)
    expect(admitsForward('127.000.000.001')).toBe(false)
    expect(admitsForward('0177.0.0.1')).toBe(false)
    expect(admitsForward('::ffff:127.0.0.08')).toBe(false)
  })
})

describe('resolveLoopbackForwardHost dial target', () => {
  it('returns a literal the resolver never sees, not the caller string', () => {
    // net.connect skips getaddrinfo for an IP literal, so the dialled address is exactly
    // the one that passed the check — including for forms that are not valid dial input.
    expect(resolveLoopbackForwardHost('localhost')).toBe('127.0.0.1')
    expect(resolveLoopbackForwardHost('  LocalHost. ')).toBe('127.0.0.1')
    expect(resolveLoopbackForwardHost('127.0.0.1.')).toBe('127.0.0.1')
    expect(resolveLoopbackForwardHost('127.0.0.53')).toBe('127.0.0.53')
    expect(resolveLoopbackForwardHost('[::1]')).toBe('::1')
    expect(resolveLoopbackForwardHost('0:0:0:0:0:0:0:1')).toBe('::1')
    expect(resolveLoopbackForwardHost('[::FFFF:127.0.0.1]')).toBe('::ffff:127.0.0.1')
  })

  it('returns null rather than a dialable address for a refused destination', () => {
    expect(resolveLoopbackForwardHost('127.evil.example.com')).toBeNull()
    expect(resolveLoopbackForwardHost('app.localhost')).toBeNull()
    expect(resolveLoopbackForwardHost('127.0.0.08')).toBeNull()
    expect(resolveLoopbackForwardHost('169.254.169.254')).toBeNull()
    expect(resolveLoopbackForwardHost('0.0.0.0')).toBeNull()
  })
})

describe('isForwardablePort', () => {
  it('accepts the usable TCP range', () => {
    expect(isForwardablePort(1)).toBe(true)
    expect(isForwardablePort(4322)).toBe(true)
    expect(isForwardablePort(65535)).toBe(true)
  })

  it('refuses out-of-range and non-integer ports', () => {
    expect(isForwardablePort(0)).toBe(false)
    expect(isForwardablePort(-1)).toBe(false)
    expect(isForwardablePort(65536)).toBe(false)
    expect(isForwardablePort(1.5)).toBe(false)
    expect(isForwardablePort(Number.NaN)).toBe(false)
  })
})

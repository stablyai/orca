import { describe, expect, it } from 'vitest'
import {
  isAllInterfacesBindHost,
  isLoopbackBindHost,
  OrcadBindAddressError,
  resolveOrcadBindHost
} from './orcad-bind-address'

describe('resolveOrcadBindHost', () => {
  it('refuses hostnames, because DNS would decide which interface got bound', () => {
    expect(() => resolveOrcadBindHost('internal.example')).toThrow(OrcadBindAddressError)
    expect(() => resolveOrcadBindHost('')).toThrow(OrcadBindAddressError)
    expect(() => resolveOrcadBindHost('0.0.0.0:80')).toThrow(OrcadBindAddressError)
    expect(() => resolveOrcadBindHost('fe80::2008%eth0')).toThrow(
      'does not support scoped IPv6 addresses'
    )
  })
})

describe('isAllInterfacesBindHost', () => {
  it.each(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0'])(
    'recognizes %s as a wildcard rather than a pinned pairing address',
    (host) => {
      expect(isAllInterfacesBindHost(resolveOrcadBindHost(host))).toBe(true)
    }
  )

  it.each(['127.0.0.1', '::1', '100.64.1.20', 'fd7a:115c:a1e0::1', 'invalid'])(
    'does not classify %s as a wildcard',
    (host) => {
      expect(isAllInterfacesBindHost(host)).toBe(false)
    }
  )
})

describe('isLoopbackBindHost', () => {
  it('matches every spelling of a loopback literal and nothing else', () => {
    for (const host of [
      '127.0.0.1',
      '127.5.5.5',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      'localhost'
    ]) {
      expect(isLoopbackBindHost(host)).toBe(true)
    }
    for (const host of [
      '100.64.1.20',
      'fd7a:115c:a1e0::1',
      '::ffff:100.64.1.20',
      '0.0.0.0',
      '::'
    ]) {
      expect(isLoopbackBindHost(host)).toBe(false)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { OrcadBindAddressError, resolveOrcadBindHost } from './orcad-bind-address'

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

import { describe, expect, it } from 'vitest'
import { isProviderAccountRef } from './provider-account-ref'

describe('isProviderAccountRef', () => {
  it('accepts bounded host and WSL references', () => {
    expect(isProviderAccountRef({ provider: 'codex', accountId: null, runtime: 'host' })).toBe(true)
    expect(
      isProviderAccountRef({
        provider: 'codex',
        accountId: 'account-a',
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    ).toBe(true)
  })

  it.each([
    { provider: 'codex\nother', accountId: null, runtime: 'host' },
    { provider: 'codex', accountId: 'account\0other', runtime: 'host' },
    { provider: 'codex', accountId: null, runtime: 'host', wslDistro: 'Ubuntu' },
    { provider: 'codex', accountId: null, runtime: 'host', secret: 'not-allowed' }
  ])('rejects malformed or over-scoped references: %o', (value) => {
    expect(isProviderAccountRef(value)).toBe(false)
  })
})

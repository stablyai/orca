import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getCodexAccountAuthWarning } from './codex-account-auth-warning'

const host = { runtime: 'host', wslDistro: null } as const

function authFailure(attemptedAccountId?: string | null): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: 'Your access token could not be refreshed. Please sign in again.',
    status: 'error',
    ...(attemptedAccountId !== undefined
      ? { usageMetadata: { attemptedAccount: { accountId: attemptedAccountId, ...host } } }
      : {})
  }
}

const warningFor = (limits: ProviderRateLimits, accountId: string | null) =>
  getCodexAccountAuthWarning({
    limits,
    target: host,
    runtime: host,
    activeAccountId: accountId,
    accountId
  })

describe('getCodexAccountAuthWarning', () => {
  it('asks only the account whose fetch failed to sign in again', () => {
    // The roster marks a active, but the failed fetch tried b's credentials.
    expect(warningFor(authFailure('b'), 'a')).toBeNull()
    expect(warningFor(authFailure('b'), 'b')).toBe('stale-sign-in')
    expect(warningFor(authFailure(null), 'b')).toBeNull()
    expect(warningFor(authFailure(null), null)).toBe('stale-sign-in')
  })

  it('names only the WSL distro the failed fetch tried', () => {
    const limits = authFailure(null)
    limits.usageMetadata = {
      attemptedAccount: { accountId: null, runtime: 'wsl', wslDistro: 'Ubuntu' }
    }
    const warn = (wslDistro: string | null) =>
      getCodexAccountAuthWarning({
        limits,
        target: { runtime: 'wsl', wslDistro },
        runtime: { runtime: 'wsl', wslDistro },
        activeAccountId: null,
        accountId: null
      })

    expect(warn('ubuntu-24.04')).toBeNull()
    expect(warn('Ubuntu')).toBe('stale-sign-in')
    // A "WSL default" view shows the poll of whichever distro that default resolved to.
    expect(warn(null)).toBe('stale-sign-in')
  })

  it('makes no claim about a failure that does not say which account it tried', () => {
    expect(warningFor(authFailure(), 'a')).toBeNull()
  })
})

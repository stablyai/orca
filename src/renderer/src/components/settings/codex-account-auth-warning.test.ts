import { describe, expect, it } from 'vitest'
import { isCodexAuthError } from '../../../../shared/codex-auth-errors'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  codexRateLimitTargetMatchesAccountRuntime,
  getCodexAccountAuthWarning
} from './codex-account-auth-warning'

function codexLimits(error: string | null, status: ProviderRateLimits['status'] = 'error') {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: 1,
    error,
    status
  } satisfies ProviderRateLimits
}

describe('codex account auth warning', () => {
  it('recognizes Codex refresh-token failures as re-auth errors', () => {
    expect(
      isCodexAuthError(
        'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
      )
    ).toBe(true)
    expect(
      isCodexAuthError(
        'Error loading configuration: Your authentication session could not be refreshed automatically.'
      )
    ).toBe(true)
  })

  it('does not treat generic Codex availability failures as auth errors', () => {
    expect(isCodexAuthError('RPC timeout')).toBe(false)
    expect(
      isCodexAuthError('Codex CLI found but could not run - Node.js may not be in your PATH')
    ).toBe(false)
  })

  it('matches the active host account on the current rate-limit target', () => {
    expect(
      getCodexAccountAuthWarning({
        limits: codexLimits(
          'Your access token could not be refreshed. Please log out and sign in again.'
        ),
        target: { runtime: 'host', wslDistro: null },
        runtime: { runtime: 'host' },
        activeAccountId: 'account-1',
        accountId: 'account-1'
      })
    ).toBe('stale-sign-in')
  })

  it('preserves stale-sign-in warnings for an OAuth system default', () => {
    expect(
      getCodexAccountAuthWarning({
        limits: codexLimits(
          'Your access token could not be refreshed. Please log out and sign in again.'
        ),
        target: { runtime: 'host', wslDistro: null },
        runtime: { runtime: 'host' },
        activeAccountId: null,
        accountId: null,
        authKind: 'oauth'
      })
    ).toBe('stale-sign-in')
  })

  it('does not warn for inactive accounts or a different runtime', () => {
    const limits = codexLimits(
      'Your access token could not be refreshed. Please log out and sign in again.'
    )

    expect(
      getCodexAccountAuthWarning({
        limits,
        target: { runtime: 'host', wslDistro: null },
        runtime: { runtime: 'host' },
        activeAccountId: 'account-1',
        accountId: 'account-2'
      })
    ).toBeNull()
    expect(
      getCodexAccountAuthWarning({
        limits,
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        runtime: { runtime: 'host' },
        activeAccountId: 'account-1',
        accountId: 'account-1'
      })
    ).toBeNull()
  })

  it('does not mislabel an API-key system default as needing re-authentication', () => {
    expect(
      getCodexAccountAuthWarning({
        limits: codexLimits('chatgpt authentication required to read rate limits'),
        target: { runtime: 'host', wslDistro: null },
        runtime: { runtime: 'host' },
        activeAccountId: null,
        accountId: null,
        authKind: 'api-key'
      })
    ).toBeNull()
  })

  it('warns only when the active system default has no usable login', () => {
    const getWarning = (authKind: 'none' | 'api-key' | 'oauth') =>
      getCodexAccountAuthWarning({
        limits: null,
        target: { runtime: 'host', wslDistro: null },
        runtime: { runtime: 'host' },
        activeAccountId: null,
        accountId: null,
        authKind
      })

    expect(getWarning('none')).toBe('missing-sign-in')
    expect(getWarning('api-key')).toBeNull()
    expect(getWarning('oauth')).toBeNull()

    expect(
      getCodexAccountAuthWarning({
        limits: null,
        target: { runtime: 'host', wslDistro: null },
        runtime: { runtime: 'host' },
        activeAccountId: 'account-1',
        accountId: null,
        authKind: 'none'
      })
    ).toBeNull()
  })

  it('allows a WSL default account location to receive the active WSL target warning', () => {
    expect(
      codexRateLimitTargetMatchesAccountRuntime(
        { runtime: 'wsl', wslDistro: 'Ubuntu' },
        { runtime: 'wsl', wslDistro: null }
      )
    ).toBe(true)
  })
})

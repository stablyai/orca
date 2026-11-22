import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getCodexAccountAuthWarning } from './codex-account-auth-warning'

const WSL = { runtime: 'wsl', wslDistro: 'Ubuntu' } as const

const API_KEY_USAGE_REJECTION = 'chatgpt authentication required to read rate limits'

function codexLimits(error: string, usageUnavailable = false): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: 1,
    error,
    status: 'error',
    ...(usageUnavailable ? { usageMetadata: { failureKind: 'usage-unavailable' } } : {})
  }
}

describe('getCodexAccountAuthWarning', () => {
  it('does not ask a WSL system default with no ChatGPT login to sign in again', () => {
    expect(
      getCodexAccountAuthWarning({
        limits: codexLimits(API_KEY_USAGE_REJECTION, true),
        target: WSL,
        runtime: WSL,
        activeAccountId: null,
        accountId: null,
        authKind: undefined
      })
    ).toBeNull()
  })

  it.each([
    {
      name: 'WSL system default with a stale ChatGPT token',
      accountId: null,
      limits: codexLimits(
        'Your access token could not be refreshed. Please log out and sign in again.'
      )
    },
    {
      name: 'WSL system default whose old ChatGPT login still holds tokens',
      accountId: null,
      limits: codexLimits(API_KEY_USAGE_REJECTION)
    },
    {
      name: 'managed WSL account hitting the API-key usage rejection',
      accountId: 'account-1',
      limits: codexLimits(API_KEY_USAGE_REJECTION, true)
    }
  ])('still asks a $name to sign in again', ({ accountId, limits }) => {
    expect(
      getCodexAccountAuthWarning({
        limits,
        target: WSL,
        runtime: WSL,
        activeAccountId: accountId,
        accountId,
        authKind: undefined
      })
    ).toBe('stale-sign-in')
  })
})

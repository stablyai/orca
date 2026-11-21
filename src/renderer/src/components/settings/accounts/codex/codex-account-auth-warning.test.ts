import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getCodexAccountAuthWarning } from './codex-account-auth-warning'

const WSL = { runtime: 'wsl', wslDistro: 'Ubuntu' } as const

function codexLimits(error: string): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: 1,
    error,
    status: 'error'
  }
}

describe('getCodexAccountAuthWarning', () => {
  it('does not ask an unresolved WSL system default to sign in again over the API-key usage rejection', () => {
    expect(
      getCodexAccountAuthWarning({
        limits: codexLimits('chatgpt authentication required to read rate limits'),
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
      error: 'Your access token could not be refreshed. Please log out and sign in again.'
    },
    {
      name: 'WSL system default whose login was wiped',
      accountId: null,
      error: 'Not logged in'
    },
    {
      name: 'managed WSL account hitting the API-key usage rejection',
      accountId: 'account-1',
      error: 'chatgpt authentication required to read rate limits'
    }
  ])('still asks a $name to sign in again', ({ accountId, error }) => {
    expect(
      getCodexAccountAuthWarning({
        limits: codexLimits(error),
        target: WSL,
        runtime: WSL,
        activeAccountId: accountId,
        accountId,
        authKind: undefined
      })
    ).toBe('stale-sign-in')
  })
})

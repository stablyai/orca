import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getClaudeSystemDefaultSignInWarning } from './claude-account-auth-warning'

const HOST = { runtime: 'host' as const, wslDistro: null }
const HOST_RUNTIME = { runtime: 'host' as const }

function claudeLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'unavailable',
    ...overrides
  }
}

describe('getClaudeSystemDefaultSignInWarning', () => {
  it('flags a local system-default row when usage confirms missing credentials', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits({
          usageMetadata: { failureKind: 'missing-credentials' }
        }),
        target: HOST,
        runtime: HOST_RUNTIME,
        activeAccountId: null
      })
    ).toBe('missing-sign-in')
  })

  it('flags a local system-default row when the usage error says the login is gone', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits({
          status: 'error',
          error: 'Not logged in. Please run /login'
        }),
        target: HOST,
        runtime: HOST_RUNTIME,
        activeAccountId: null
      })
    ).toBe('missing-sign-in')
  })

  it('ignores a desktop snapshot when the caller has no limits for this host', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: null,
        target: HOST,
        runtime: HOST_RUNTIME,
        activeAccountId: null
      })
    ).toBeNull()
  })

  it('stays quiet when a saved Claude account is the active login', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits({
          usageMetadata: { failureKind: 'missing-credentials' }
        }),
        target: HOST,
        runtime: HOST_RUNTIME,
        activeAccountId: 'saved-claude'
      })
    ).toBeNull()
  })

  it('stays quiet when the usage poll describes a different runtime', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits({
          usageMetadata: { failureKind: 'missing-credentials' }
        }),
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        runtime: HOST_RUNTIME,
        activeAccountId: null
      })
    ).toBeNull()
  })

  it('stays quiet when the poll already has usage windows', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits({
          status: 'ok',
          session: {
            usedPercent: 10,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          usageMetadata: { failureKind: 'missing-credentials' }
        }),
        target: HOST,
        runtime: HOST_RUNTIME,
        activeAccountId: null
      })
    ).toBeNull()
  })

  it('does not treat a network failure as signed out', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits({
          status: 'error',
          error: 'network down',
          usageMetadata: { failureKind: 'network' }
        }),
        target: HOST,
        runtime: HOST_RUNTIME,
        activeAccountId: null
      })
    ).toBeNull()
  })

  it('does not warn while the first usage poll is still fetching', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits({
          status: 'fetching',
          usageMetadata: { failureKind: 'missing-credentials' }
        }),
        target: HOST,
        runtime: HOST_RUNTIME,
        activeAccountId: null
      })
    ).toBeNull()
  })
})

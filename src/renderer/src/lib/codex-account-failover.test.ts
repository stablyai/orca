import { describe, expect, it } from 'vitest'
import type { CodexManagedAccountSummary } from '../../../shared/types'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../shared/rate-limit-types'
import { chooseCodexFailoverAccount } from './codex-account-failover'

function codexLimits(
  usedSessionPercent: number,
  usedWeeklyPercent: number,
  overrides: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'codex',
    session: {
      usedPercent: usedSessionPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: {
      usedPercent: usedWeeklyPercent,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    },
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    ...overrides
  }
}

function account(id: string, updatedAt: number): CodexManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    providerAccountId: null,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: updatedAt,
    updatedAt,
    lastAuthenticatedAt: updatedAt
  }
}

describe('chooseCodexFailoverAccount', () => {
  it('chooses the least-used inactive account after a usage-limit error', () => {
    const active = codexLimits(100, 100, {
      status: 'error',
      error: "You've hit your usage limit."
    })

    const accounts = [account('account-a', 3), account('account-b', 2), account('account-c', 1)]
    const inactiveCodexAccounts: InactiveAccountUsage[] = [
      { accountId: 'account-b', rateLimits: codexLimits(8, 22), updatedAt: 2, isFetching: false },
      { accountId: 'account-c', rateLimits: codexLimits(90, 90), updatedAt: 1, isFetching: false }
    ]

    expect(
      chooseCodexFailoverAccount({
        activeAccountId: 'account-a',
        activeCodexUsage: active,
        accounts,
        inactiveCodexAccounts
      })
    ).toBe('account-b')
  })

  it('stays on the current account when the active usage is still available', () => {
    const active = codexLimits(8, 22)
    const accounts = [account('account-a', 3), account('account-b', 2)]
    const inactiveCodexAccounts: InactiveAccountUsage[] = [
      { accountId: 'account-b', rateLimits: codexLimits(20, 30), updatedAt: 2, isFetching: false }
    ]

    expect(
      chooseCodexFailoverAccount({
        activeAccountId: 'account-a',
        activeCodexUsage: active,
        accounts,
        inactiveCodexAccounts
      })
    ).toBe(null)
  })
})

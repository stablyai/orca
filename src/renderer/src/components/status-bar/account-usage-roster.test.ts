// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { buildAccountUsageRoster } from './account-usage-roster'

function limits(provider: 'claude' | 'codex', usedPercent: number): ProviderRateLimits {
  return {
    provider,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    status: 'ok',
    error: null,
    updatedAt: 100
  }
}
function fixture() {
  const accounts: ProviderAccountsSnapshot = {
    claude: {
      activeAccountId: 'first',
      accounts: ['first', 'second'].map((id) => ({
        id,
        email: `${id}@example.test`,
        authMethod: 'subscription-oauth',
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      }))
    },
    codex: {
      activeAccountId: 'codex-first',
      accounts: ['codex-first', 'codex-second'].map((id) => ({
        id,
        email: `${id}@example.test`,
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      }))
    },
    rateLimits: null
  }
  const rateLimits = createEmptyRateLimitState({
    claude: limits('claude', 8),
    codex: limits('codex', 15),
    inactiveClaudeAccounts: [
      { accountId: 'second', rateLimits: limits('claude', 58), updatedAt: 100, isFetching: false }
    ],
    inactiveCodexAccounts: [
      {
        accountId: 'codex-second',
        rateLimits: limits('codex', 70),
        updatedAt: 100,
        isFetching: false
      }
    ]
  })
  return {
    providers: [limits('claude', 8), limits('codex', 15)],
    accounts,
    rateLimits,
    ownerKey: 'local'
  }
}

describe('account usage roster', () => {
  it('joins both providers to independent account values without repeating the selected account', () => {
    const entries = buildAccountUsageRoster(fixture())
    expect(entries.map((entry) => [entry.accountId, entry.limits?.session?.usedPercent])).toEqual([
      ['first', 8],
      ['second', 58],
      ['codex-first', 15],
      ['codex-second', 70]
    ])
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(4)
  })
  it('distinguishes Claude accounts that share an email', () => {
    const input = fixture()
    for (const account of input.accounts.claude.accounts) {
      account.email = 'same@example.test'
    }
    const entries = buildAccountUsageRoster(input).filter((entry) => entry.provider === 'claude')
    expect(new Set(entries.map((entry) => entry.label)).size).toBe(2)
  })
  it('retains unavailable accounts without inventing a zero and drops removed accounts', () => {
    const input = fixture()
    input.rateLimits.inactiveClaudeAccounts = []
    let entries = buildAccountUsageRoster(input)
    expect(entries.find((entry) => entry.accountId === 'second')?.limits).toBeNull()
    input.accounts.claude.accounts = input.accounts.claude.accounts.filter(
      (account) => account.id !== 'second'
    )
    entries = buildAccountUsageRoster(input)
    expect(entries.some((entry) => entry.accountId === 'second')).toBe(false)
  })
  it('honors provider visibility even when hidden providers have saved accounts', () => {
    const input = fixture()
    input.providers = input.providers.filter((provider) => provider.provider === 'codex')
    expect(buildAccountUsageRoster(input).map((entry) => entry.provider)).toEqual([
      'codex',
      'codex'
    ])
  })
  it('never assigns active host usage to a WSL account', () => {
    const input = fixture()
    const account = input.accounts.claude.accounts[1]!
    account.managedAuthRuntime = 'wsl'
    account.wslDistro = 'Ubuntu'
    input.accounts.claude.activeAccountIdsByRuntime = { host: 'first', wsl: { Ubuntu: 'second' } }
    input.rateLimits.inactiveClaudeAccounts = []
    const entries = buildAccountUsageRoster(input)
    const wsl = entries.find((entry) => entry.accountId === 'second')
    expect(wsl?.label).toContain('WSL Ubuntu')
    expect(wsl?.selected).toBe(false)
    expect(wsl?.limits).toBeNull()
    expect(entries.find((entry) => entry.accountId === 'first')?.limits?.session?.usedPercent).toBe(
      8
    )
  })
})

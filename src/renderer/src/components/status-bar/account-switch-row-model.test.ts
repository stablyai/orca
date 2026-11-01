import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  filterAccountSwitchEntries,
  getAccountSwitchUsage,
  getPrevailingWorkspace,
  groupAccountSwitchEntries,
  type AccountSwitchListEntry
} from './account-switch-row-model'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

function windowOf(usedPercent: number, resetsAt: number | null = null): RateLimitWindow {
  return { usedPercent, windowMinutes: 10_080, resetsAt, resetDescription: null }
}

function limitsOf(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function entry(
  email: string | null,
  usage: AccountSwitchListEntry['usage'],
  extra: Partial<AccountSwitchListEntry> = {}
): AccountSwitchListEntry {
  return {
    key: email ?? 'system',
    email,
    workspace: null,
    identifier: null,
    usage,
    needsSignIn: false,
    ...extra
  }
}

describe('getAccountSwitchUsage', () => {
  it('compares accounts on the weekly window even when the session window is tighter', () => {
    const usage = getAccountSwitchUsage(
      limitsOf({ session: windowOf(70), weekly: windowOf(20), fableWeekly: windowOf(40) })
    )
    expect(usage).toEqual({ kind: 'usage', usedPercent: 20 })
  })

  it('falls back to the monthly spend cap for plans without session or weekly windows', () => {
    const usage = getAccountSwitchUsage(limitsOf({ monthly: windowOf(80) }))
    expect(usage).toEqual({ kind: 'usage', usedPercent: 80 })
  })

  it('reports the reset time of the last exhausted general plan window', () => {
    const usage = getAccountSwitchUsage(
      limitsOf({ session: windowOf(100, 1_000), weekly: windowOf(100, 9_000) })
    )
    expect(usage).toEqual({ kind: 'plan-limit', resetsAt: 9_000, extraUsageAvailable: false })
  })

  it('does not mistake a model-specific limit for an exhausted general plan', () => {
    expect(
      getAccountSwitchUsage(
        limitsOf({ session: windowOf(5), weekly: windowOf(10), fableWeekly: windowOf(100) })
      )
    ).toEqual({ kind: 'usage', usedPercent: 10 })
  })

  it.each([20, 0, null])(
    'keeps paid overage separate from plan exhaustion (balance %s)',
    (balance) => {
      const usage = getAccountSwitchUsage(
        limitsOf({
          weekly: windowOf(100),
          extraUsage: {
            unit: 'currency',
            enabled: true,
            balance,
            currencyCode: 'USD',
            spent: 0,
            spendLimit: 20,
            spentPercent: 0,
            resetsAt: null,
            disabledReason: null
          }
        })
      )
      expect(usage).toEqual({
        kind: 'plan-limit',
        resetsAt: null,
        extraUsageAvailable: balance === 20
      })
      const groups = groupAccountSwitchEntries([entry('paid@example.com', usage)], 'name')
      expect(groups[0].kind).toBe(balance === 20 ? 'accounts' : 'plan-limit')
    }
  )
})

describe('account list grouping', () => {
  const rows = [
    entry('zed@example.com', { kind: 'usage', usedPercent: 5 }),
    entry('amy@example.com', { kind: 'usage', usedPercent: 60 }),
    entry('late@example.com', { kind: 'plan-limit', resetsAt: 9_000, extraUsageAvailable: false }),
    entry('soon@example.com', { kind: 'plan-limit', resetsAt: 1_000, extraUsageAvailable: false }),
    entry('gone@example.com', { kind: 'none' }, { needsSignIn: true }),
    entry(null, { kind: 'none' })
  ]

  it('separates plan limits and sign-in state and orders plan limits by reset', () => {
    const groups = groupAccountSwitchEntries(rows, 'name')
    expect(groups.map((group) => [group.kind, group.entries.map((row) => row.key)])).toEqual([
      ['default', ['system']],
      ['accounts', ['amy@example.com', 'zed@example.com']],
      ['plan-limit', ['soon@example.com', 'late@example.com']],
      ['sign-in', ['gone@example.com']]
    ])
  })

  it('puts the least-used available account first when asked', () => {
    const available = groupAccountSwitchEntries(rows, 'least-used').find(
      (group) => group.kind === 'accounts'
    )
    expect(available?.entries.map((row) => row.key)).toEqual(['zed@example.com', 'amy@example.com'])
  })

  it('filters on workspace and short ID as well as email', () => {
    const tagged = [
      entry('a@example.com', { kind: 'none' }, { workspace: 'Team' }),
      entry('a@example.com', { kind: 'none' }, { key: 'a2', identifier: '9a41e0d3' })
    ]
    expect(filterAccountSwitchEntries(tagged, 'team')).toHaveLength(1)
    expect(filterAccountSwitchEntries(tagged, '9A41')).toHaveLength(1)
  })

  it('only treats a workspace as the default when several accounts share it', () => {
    expect(
      getPrevailingWorkspace([
        entry('a@example.com', { kind: 'none' }, { workspace: 'Personal (Pro)' }),
        entry('b@example.com', { kind: 'none' }, { workspace: 'Personal (Pro)' }),
        entry('c@example.com', { kind: 'none' }, { workspace: 'Team' })
      ])
    ).toBe('Personal (Pro)')
    expect(
      getPrevailingWorkspace([entry('a@example.com', { kind: 'none' }, { workspace: 'Team' })])
    ).toBeNull()
  })
})

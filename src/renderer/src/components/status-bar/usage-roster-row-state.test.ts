import { describe, expect, it, vi } from 'vitest'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { buildUsageRosterEntries, getUsageRosterRowState } from './usage-roster-row-state'

function provider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
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

describe('getUsageRosterRowState', () => {
  it('keeps fetching providers in a loading state instead of calling them signed out', () => {
    expect(getUsageRosterRowState(provider({ status: 'fetching' }), false)).toEqual({
      kind: 'loading',
      statusLabel: 'Loading usage…'
    })
  })

  it('preserves transient Claude failure copy instead of offering sign-in', () => {
    expect(
      getUsageRosterRowState(
        provider({
          status: 'error',
          error: 'OAuth token is stale',
          usageMetadata: { failureKind: 'stale-token' }
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Refreshing sign-in' })
    expect(
      getUsageRosterRowState(
        provider({
          status: 'error',
          error: 'network unavailable',
          usageMetadata: { failureKind: 'network' }
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Network issue' })
  })

  it('offers sign-in only for confirmed signed-out failures', () => {
    expect(
      getUsageRosterRowState(
        provider({ status: 'error', usageMetadata: { failureKind: 'missing-credentials' } }),
        false
      )
    ).toEqual({ kind: 'sign-in', statusLabel: 'not signed in' })
    expect(
      getUsageRosterRowState(
        provider({
          provider: 'codex',
          status: 'error',
          error: 'ChatGPT authentication required to read rate limits'
        }),
        false
      )
    ).toEqual({ kind: 'sign-in', statusLabel: 'not signed in' })
  })

  it('does not turn an expired CLI-owned Kimi token into a sign-in action', () => {
    expect(
      getUsageRosterRowState(
        provider({
          provider: 'kimi',
          status: 'error',
          error: 'Kimi token expired — open Kimi to refresh'
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Refresh failed' })
  })

  it('distinguishes unavailable and empty successful responses', () => {
    expect(
      getUsageRosterRowState(
        provider({ status: 'unavailable', error: 'Claude CLI not found' }),
        false
      )
    ).toEqual({ kind: 'unavailable', statusLabel: 'Usage unavailable' })
    expect(getUsageRosterRowState(provider(), false)).toEqual({
      kind: 'empty',
      statusLabel: 'No usage data'
    })
  })

  it('lets real usage data win over a stale error status', () => {
    expect(getUsageRosterRowState(provider({ status: 'error' }), true)).toEqual({
      kind: 'usage',
      statusLabel: null
    })
  })
})

function usageWindow(
  usedPercent: number,
  windowMinutes: number
): NonNullable<ProviderRateLimits['session']> {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function codexLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'codex',
    session: usageWindow(22, 300),
    weekly: usageWindow(11, 10_080),
    updatedAt: 1_000,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function inactiveAccount(
  accountId: string,
  rateLimits: ProviderRateLimits | null,
  overrides: Partial<InactiveAccountUsage> = {}
): InactiveAccountUsage {
  return {
    accountId,
    rateLimits,
    updatedAt: rateLimits?.updatedAt ?? 0,
    isFetching: false,
    ...overrides
  }
}

describe('buildUsageRosterEntries', () => {
  it('shows the active Codex provider and each inactive Codex account', () => {
    const active = codexLimits()
    const inactiveLimits = codexLimits({
      session: usageWindow(81, 300),
      weekly: usageWindow(44, 10_080),
      updatedAt: 2_000
    })
    const entries = buildUsageRosterEntries(
      [active, provider()],
      [inactiveAccount('acct-work', inactiveLimits)],
      { 'acct-work': 'work@example.com' }
    )

    const codexEntries = entries.filter((entry) => entry.limits.provider === 'codex')
    expect(codexEntries).toHaveLength(2)
    expect(entries.some((entry) => entry.limits.provider === 'claude')).toBe(true)

    const activeEntry = entries.find((entry) => entry.key === 'codex')
    const inactiveEntry = entries.find((entry) => entry.accountId === 'acct-work')
    expect(activeEntry?.interactive).toBe(true)
    expect(activeEntry?.limits.session?.usedPercent).toBe(22)
    expect(inactiveEntry).toEqual(
      expect.objectContaining({
        interactive: false,
        title: 'work@example.com',
        updatedAt: 2_000,
        limits: inactiveLimits
      })
    )
  })

  it('uses last-known percents from inactiveCodexAccounts while a refetch is in flight', () => {
    const lastKnown = codexLimits({
      session: usageWindow(81, 300),
      weekly: usageWindow(44, 10_080)
    })
    const entries = buildUsageRosterEntries(
      [codexLimits()],
      [inactiveAccount('acct-work', lastKnown, { isFetching: true })]
    )
    const inactiveEntry = entries.find((entry) => entry.accountId === 'acct-work')
    expect(inactiveEntry?.limits.session?.usedPercent).toBe(81)
    expect(inactiveEntry?.limits.weekly?.usedPercent).toBe(44)
    expect(inactiveEntry?.interactive).toBe(false)
  })

  it('does not add inactive Codex rows when Codex is not in the roster', () => {
    const entries = buildUsageRosterEntries(
      [provider()],
      [inactiveAccount('acct-work', codexLimits({ session: usageWindow(81, 300) }))]
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.limits.provider).toBe('claude')
  })
})

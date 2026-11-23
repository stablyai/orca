import { describe, expect, it } from 'vitest'
import {
  getObservedAccountUsage,
  indexAccountUsageObservations
} from './account-usage-observations'
import type { ProviderRateLimits, UsageReadingAccount } from './rate-limit-types'
import { CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID } from '../../agent-accounts/claude/claude-system-default-usage'

function reading(readingAccount?: UsageReadingAccount, updatedAt = 1): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok',
    ...(readingAccount ? { usageMetadata: { readingAccount } } : {})
  }
}

const host = { runtime: 'host', wslDistro: null } as const

describe('indexAccountUsageObservations', () => {
  it('shows a reading only on the account it names, not on the roster-selected one', () => {
    // The roster still marks a active, but the last fetch read b's credentials.
    const usage = reading({ accountId: 'b', ...host })
    const observations = indexAccountUsageObservations(usage, [])

    expect(getObservedAccountUsage(observations, { accountId: 'a', ...host })).toBeNull()
    expect(getObservedAccountUsage(observations, { accountId: 'b', ...host })).toBe(usage)
    expect(getObservedAccountUsage(observations, { accountId: null, ...host })).toBeNull()
  })

  it('keeps System default separate from every saved account', () => {
    const usage = reading({ accountId: null, ...host })
    const observations = indexAccountUsageObservations(usage, [])

    expect(getObservedAccountUsage(observations, { accountId: null, ...host })).toBe(usage)
    expect(getObservedAccountUsage(observations, { accountId: 'a', ...host })).toBeNull()
  })

  it("reads System default's reserved host entry, and only a reading that names System default", () => {
    const own = reading({ accountId: null, ...host })
    const observations = indexAccountUsageObservations(reading({ accountId: 'a', ...host }), [
      { accountId: CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID, rateLimits: own }
    ])
    expect(getObservedAccountUsage(observations, { accountId: null, ...host })).toBe(own)

    // A saved account's reading kept under the reserved key is not System default's.
    const misfiled = indexAccountUsageObservations(null, [
      {
        accountId: CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID,
        rateLimits: reading({ accountId: 'a', ...host })
      }
    ])
    expect(getObservedAccountUsage(misfiled, { accountId: null, ...host })).toBeNull()
  })

  it('matches a WSL reading only to its own distro', () => {
    const usage = reading({ accountId: 'a', runtime: 'wsl', wslDistro: 'Ubuntu' })
    const observations = indexAccountUsageObservations(usage, [])
    const wsl = (wslDistro: string | null) =>
      getObservedAccountUsage(observations, { accountId: 'a', runtime: 'wsl', wslDistro })

    expect(wsl('ubuntu-24.04')).toBeNull()
    expect(wsl(null)).toBeNull()
    expect(getObservedAccountUsage(observations, { accountId: 'a', ...host })).toBeNull()
    expect(wsl('ubuntu')).toBe(usage)
  })

  it('attributes nothing from an older host that does not stamp readings', () => {
    const observations = indexAccountUsageObservations(reading(), [
      { accountId: 'a', rateLimits: reading() }
    ])

    expect(getObservedAccountUsage(observations, { accountId: 'a', ...host })).toBeNull()
    expect(getObservedAccountUsage(observations, { accountId: null, ...host })).toBeNull()
  })

  it('shows a failure with no earlier windows on the account it tried', () => {
    const failure: ProviderRateLimits = {
      ...reading(),
      session: null,
      status: 'error',
      error: 'Sign in again to use this account.',
      usageMetadata: { attemptedAccount: { accountId: 'b', ...host } }
    }
    const observations = indexAccountUsageObservations(null, [
      { accountId: 'b', rateLimits: failure }
    ])

    expect(getObservedAccountUsage(observations, { accountId: 'b', ...host })).toMatchObject({
      status: 'error',
      error: 'Sign in again to use this account.'
    })
    expect(getObservedAccountUsage(observations, { accountId: 'a', ...host })).toBeNull()
  })

  it("keeps b's failure but not the windows or plan kept from an unnamed reading", () => {
    // An unattributed reading's windows and plan were kept through b's failure.
    const kept: ProviderRateLimits = {
      ...reading(),
      planType: 'pro',
      status: 'error',
      error: 'Sign in again.',
      usageMetadata: { attemptedAccount: { accountId: 'b', ...host } }
    }
    const observations = indexAccountUsageObservations(kept, [])

    expect(getObservedAccountUsage(observations, { accountId: 'b', ...host })).toMatchObject({
      status: 'error',
      error: 'Sign in again.',
      session: null,
      planType: null
    })
    expect(getObservedAccountUsage(observations, { accountId: 'a', ...host })).toBeNull()
  })

  it('ignores a cached entry whose reading names another account', () => {
    // An outgoing reading seeded under a after another window had already switched to b.
    const observations = indexAccountUsageObservations(null, [
      { accountId: 'a', rateLimits: reading({ accountId: 'b', ...host }) }
    ])

    expect(getObservedAccountUsage(observations, { accountId: 'a', ...host })).toBeNull()
    expect(getObservedAccountUsage(observations, { accountId: 'b', ...host })).toBeNull()
  })
})

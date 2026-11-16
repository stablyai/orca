import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  UsageReadingAccount
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  getObservedAccountPlan,
  getObservedCodexAccountPlan,
  indexObservedAccountPlans
} from './observed-account-plans'

const HOST = { runtime: 'host', wslDistro: null } as const

function reading(planType: string, readingAccount?: UsageReadingAccount): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    planType,
    updatedAt: 1,
    error: null,
    status: 'ok',
    ...(readingAccount ? { usageMetadata: { readingAccount } } : {})
  }
}

describe('observed account plans', () => {
  it('shows the active plan on the account it was read for, not the roster selection', () => {
    // Another window switched to B; this roster still lists A as selected.
    const plans = indexObservedAccountPlans(reading('pro', { accountId: 'b', ...HOST }), [])
    expect(getObservedAccountPlan(plans, 'a', HOST)).toBeNull()
    expect(getObservedAccountPlan(plans, 'b', HOST)).toBe('Pro')
  })

  it('leaves rows blank for readings that name no account or another one', () => {
    const plans = indexObservedAccountPlans(reading('max_20x'), [
      {
        accountId: 'a',
        rateLimits: reading('team', { accountId: 'c', ...HOST }),
        updatedAt: 1,
        isFetching: false
      },
      {
        accountId: 'd',
        rateLimits: reading('unknown', { accountId: 'd', ...HOST }),
        updatedAt: 1,
        isFetching: false
      }
    ])
    expect(getObservedAccountPlan(plans, 'a', HOST)).toBeNull()
    expect(getObservedAccountPlan(plans, 'c', HOST)).toBeNull()
    expect(getObservedAccountPlan(plans, 'd', HOST)).toBeNull()
  })

  it('matches a WSL reading only to its own distro', () => {
    const plans = indexObservedAccountPlans(null, [
      {
        accountId: 'w',
        rateLimits: reading('max_20x', { accountId: 'w', runtime: 'wsl', wslDistro: 'Ubuntu' }),
        updatedAt: 1,
        isFetching: false
      }
    ])
    expect(getObservedAccountPlan(plans, 'w', { runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
      'Max 20x'
    )
    expect(getObservedAccountPlan(plans, 'w', { runtime: 'wsl', wslDistro: 'Debian' })).toBeNull()
    expect(getObservedAccountPlan(plans, 'w', HOST)).toBeNull()
  })

  it('keeps a Codex workspace label and adds no plan when the label may name one', () => {
    const plans = indexObservedAccountPlans(reading('pro', { accountId: 'a', ...HOST }), [])
    expect(
      getObservedCodexAccountPlan(plans, { id: 'a', workspaceLabel: 'Personal (Plus)' }, HOST)
    ).toBeNull()
    expect(getObservedCodexAccountPlan(plans, { id: 'a', workspaceLabel: 'Acme' }, HOST)).toBe(
      'Pro'
    )
  })
})

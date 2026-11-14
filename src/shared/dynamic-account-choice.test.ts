import { describe, expect, it } from 'vitest'
import {
  chooseDynamicAccount,
  countDynamicAccountPick,
  type DynamicAccountCandidate,
  type DynamicAccountPicks
} from './dynamic-account-choice'
import type { ProviderRateLimits } from './rate-limit-types'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function account(
  accountId: string,
  sessionUsed: number,
  weeklyUsed: number,
  weeklyResetsInHours: number,
  updatedAt = NOW
): DynamicAccountCandidate {
  const rateLimits: ProviderRateLimits = {
    provider: 'claude',
    session: {
      usedPercent: sessionUsed,
      windowMinutes: 300,
      resetsAt: NOW + 2 * HOUR,
      resetDescription: null
    },
    weekly: {
      usedPercent: weeklyUsed,
      windowMinutes: 10080,
      resetsAt: NOW + weeklyResetsInHours * HOUR,
      resetDescription: null
    },
    updatedAt,
    error: null,
    status: 'ok'
  }
  return { accountId, rateLimits }
}

describe('chooseDynamicAccount', () => {
  it('picks the soonest weekly reset among accounts above the margin', () => {
    const chosen = chooseDynamicAccount(
      [account('roomy', 10, 10, 120), account('expiring', 40, 80, 20), account('later', 0, 0, 60)],
      5,
      NOW
    )
    expect(chosen?.accountId).toBe('expiring')
  })

  it('skips accounts inside the margin in any window', () => {
    const chosen = chooseDynamicAccount(
      [
        account('session-full', 96, 10, 10),
        account('weekly-full', 10, 97, 12),
        account('ok', 50, 50, 90)
      ],
      5,
      NOW
    )
    expect(chosen?.accountId).toBe('ok')
  })

  it('counts a window whose reset has passed as empty', () => {
    const chosen = chooseDynamicAccount([account('reset', 10, 100, -1)], 5, NOW)
    expect(chosen?.accountId).toBe('reset')
  })

  it('breaks a weekly reset tie by headroom', () => {
    const chosen = chooseDynamicAccount(
      [account('tight', 70, 70, 30), account('loose', 20, 20, 30)],
      5,
      NOW
    )
    expect(chosen?.accountId).toBe('loose')
  })

  it('ignores stale readings', () => {
    const chosen = chooseDynamicAccount(
      [account('stale', 0, 0, 1, NOW - 2 * HOUR), account('fresh', 50, 50, 90)],
      5,
      NOW
    )
    expect(chosen?.accountId).toBe('fresh')
  })

  it('never picks an exhausted account with a zero margin', () => {
    const chosen = chooseDynamicAccount(
      [account('roomy', 10, 10, 120), account('exhausted', 100, 50, 10)],
      0,
      NOW
    )
    expect(chosen?.accountId).toBe('roomy')
  })

  it('spreads a burst of launches before the readings show them', () => {
    const expiring = account('expiring', 0, 92, 10)
    const picks: DynamicAccountPicks = new Map()
    countDynamicAccountPick(picks, expiring)
    const chosen = chooseDynamicAccount([expiring, account('roomy', 0, 10, 120)], 5, NOW, picks)
    expect(chosen?.accountId).toBe('roomy')
  })

  it('keeps the selected account when nothing qualifies', () => {
    expect(chooseDynamicAccount([account('full', 99, 99, 10)], 5, NOW)).toBeNull()
  })
})

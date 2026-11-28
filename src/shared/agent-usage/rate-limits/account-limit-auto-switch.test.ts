import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from './rate-limit-types'
import {
  decideAccountLimitSwitch,
  resolveAccountAutoSwitchThreshold
} from './account-limit-auto-switch'

function window(usedPercent: number, windowMinutes = 300): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function limits(
  session: number | null,
  weekly: number | null = null,
  status: ProviderRateLimits['status'] = 'ok'
): ProviderRateLimits {
  return {
    provider: 'claude',
    session: session === null ? null : window(session),
    weekly: weekly === null ? null : window(weekly, 10_080),
    updatedAt: 1,
    error: null,
    status
  }
}

describe('decideAccountLimitSwitch', () => {
  it('moves to the least-used account below the threshold once the active one reaches it', () => {
    expect(
      decideAccountLimitSwitch({
        active: limits(95),
        thresholdPercent: 95,
        candidates: [
          { accountId: 'b', limits: limits(60) },
          { accountId: 'c', limits: limits(20, 30) },
          { accountId: 'd', limits: limits(10) }
        ]
      })
    ).toEqual({ kind: 'switch', accountId: 'd', usedPercent: 10 })
  })

  it('stays while the active account is below the threshold', () => {
    expect(
      decideAccountLimitSwitch({
        active: limits(94, 50),
        thresholdPercent: 95,
        candidates: [{ accountId: 'b', limits: limits(0) }]
      })
    ).toEqual({ kind: 'under-limit' })
  })

  it('counts the most spent window, so a full weekly limit triggers a switch', () => {
    expect(
      decideAccountLimitSwitch({
        active: limits(12, 100),
        thresholdPercent: 95,
        candidates: [
          { accountId: 'b', limits: limits(5, 96) },
          { accountId: 'c', limits: limits(40, 70) }
        ]
      })
    ).toEqual({ kind: 'switch', accountId: 'c', usedPercent: 70 })
  })

  it('does nothing when the active reading failed or has no windows', () => {
    const candidates = [{ accountId: 'b', limits: limits(0) }]
    expect(
      decideAccountLimitSwitch({
        active: limits(100, null, 'error'),
        thresholdPercent: 95,
        candidates
      })
    ).toEqual({ kind: 'under-limit' })
    expect(
      decideAccountLimitSwitch({ active: limits(null), thresholdPercent: 95, candidates })
    ).toEqual({ kind: 'under-limit' })
    expect(decideAccountLimitSwitch({ active: null, thresholdPercent: 95, candidates })).toEqual({
      kind: 'under-limit'
    })
  })

  it('never picks an account whose usage is unknown or over the threshold', () => {
    expect(
      decideAccountLimitSwitch({
        active: limits(99),
        thresholdPercent: 95,
        candidates: [
          { accountId: 'b', limits: limits(97) },
          { accountId: 'c', limits: limits(5, null, 'error') },
          { accountId: 'd', limits: null },
          { accountId: 'e', limits: limits(null) }
        ]
      })
    ).toEqual({ kind: 'no-account-under-limit' })
  })
})

describe('resolveAccountAutoSwitchThreshold', () => {
  it('defaults to 95 and keeps saved values within 1–100', () => {
    expect(resolveAccountAutoSwitchThreshold(undefined)).toBe(95)
    expect(resolveAccountAutoSwitchThreshold(Number.NaN)).toBe(95)
    expect(resolveAccountAutoSwitchThreshold(80)).toBe(80)
    expect(resolveAccountAutoSwitchThreshold(150)).toBe(100)
    expect(resolveAccountAutoSwitchThreshold(0)).toBe(1)
  })
})

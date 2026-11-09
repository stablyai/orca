import { describe, expect, it } from 'vitest'
import {
  formatDollars,
  formatHours,
  includedUsagePercent,
  planBillingTone
} from './plan-billing-format'
import { sampleTeam as base } from './plan-billing-fixtures'

describe('plan billing format', () => {
  it('formats hours with at most one decimal', () => {
    expect(formatHours(0)).toBe('0')
    expect(formatHours(3600)).toBe('1')
    expect(formatHours(5400)).toBe('1.5')
    expect(formatHours(3600 + 1)).toBe('1')
    expect(formatHours(-5)).toBe('0')
  })

  it('formats dollars, dropping cents for whole amounts', () => {
    expect(formatDollars(75)).toBe('$0.75')
    expect(formatDollars(150)).toBe('$1.50')
    expect(formatDollars(2500)).toBe('$25')
  })

  it('clamps the usage bar', () => {
    expect(includedUsagePercent({ ...base, usedSeconds: 24 * 3600 })).toBe(20)
    expect(includedUsagePercent({ ...base, usedSeconds: 200 * 3600 })).toBe(100)
    expect(includedUsagePercent({ ...base, includedSeconds: 0 })).toBe(0)
  })

  it('flags exhausted, ending and blocked plans', () => {
    expect(planBillingTone(base)).toBe('ok')
    expect(planBillingTone({ ...base, remainingIncludedSeconds: 0 })).toBe('warning')
    expect(planBillingTone({ ...base, cancelAtPeriodEnd: true })).toBe('warning')
    expect(planBillingTone({ ...base, canStartSandbox: false, reason: 'payment_past_due' })).toBe(
      'blocked'
    )
  })
})

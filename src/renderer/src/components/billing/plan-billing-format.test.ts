import { describe, expect, it } from 'vitest'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { formatHours, includedUsagePercent, planBillingTone } from './plan-billing-format'

const base: OrcaBillingEntitlement = {
  plan: 'pro',
  planLabel: 'Pro',
  status: 'active',
  seats: 1,
  period: { start: 0, end: 1 },
  cancelAtPeriodEnd: false,
  includedSeconds: 50 * 3600,
  usedSeconds: 10 * 3600,
  remainingIncludedSeconds: 40 * 3600,
  overageSeconds: 0,
  overageEnabled: true,
  overageCapSeconds: 100 * 3600,
  canStartSandbox: true,
  reason: null,
  canManageBilling: true,
  plans: []
}

describe('plan billing format', () => {
  it('formats hours with at most one decimal', () => {
    expect(formatHours(0)).toBe('0')
    expect(formatHours(3600)).toBe('1')
    expect(formatHours(5400)).toBe('1.5')
    expect(formatHours(3600 + 1)).toBe('1')
    expect(formatHours(-5)).toBe('0')
  })

  it('clamps the usage bar', () => {
    expect(includedUsagePercent(base)).toBe(20)
    expect(includedUsagePercent({ ...base, usedSeconds: 80 * 3600 })).toBe(100)
    expect(includedUsagePercent({ ...base, includedSeconds: 0 })).toBe(0)
  })

  it('flags exhausted, ending and blocked plans', () => {
    expect(planBillingTone(base)).toBe('ok')
    expect(planBillingTone({ ...base, remainingIncludedSeconds: 0 })).toBe('warning')
    expect(planBillingTone({ ...base, cancelAtPeriodEnd: true })).toBe('warning')
    expect(
      planBillingTone({
        ...base,
        canStartSandbox: false,
        reason: 'payment_past_due'
      })
    ).toBe('blocked')
  })
})

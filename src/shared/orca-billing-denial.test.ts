import { describe, expect, it } from 'vitest'
import { classifyEntitlementDenial } from './orca-billing'

describe('classifyEntitlementDenial', () => {
  it('maps every billing and start-gate reason to one category', () => {
    expect(classifyEntitlementDenial('no_subscription')).toBe('plan')
    expect(classifyEntitlementDenial('subscription_inactive')).toBe('plan')
    expect(classifyEntitlementDenial('no plan')).toBe('plan')
    expect(classifyEntitlementDenial('included_hours_exhausted')).toBe('hours')
    expect(classifyEntitlementDenial('overage_cap_reached')).toBe('spendCap')
    expect(classifyEntitlementDenial('payment_past_due')).toBe('payment')
    expect(classifyEntitlementDenial('payment_grace_expired')).toBe('payment')
    expect(classifyEntitlementDenial('concurrency_limit')).toBe('teamLimit')
    expect(classifyEntitlementDenial('member_concurrency_limit')).toBe('memberLimit')
    expect(classifyEntitlementDenial('machine_size_not_in_plan')).toBe('machineSize')
  })

  it('falls back to other for unknown or missing reasons', () => {
    expect(classifyEntitlementDenial('something_new')).toBe('other')
    expect(classifyEntitlementDenial(undefined)).toBe('other')
    expect(classifyEntitlementDenial(null)).toBe('other')
  })
})

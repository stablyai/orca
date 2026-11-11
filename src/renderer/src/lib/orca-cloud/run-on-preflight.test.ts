// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/billing/plans/plans-page-store', () => ({ openPlansPage: vi.fn() }))

import {
  devBillingFaultAccess,
  orcaCloudNeedsFixFirst,
  orcaCloudWallNotice
} from './run-on-preflight'

afterEach(() => {
  localStorage.removeItem('orca:dev:billingFault')
})

describe('orcaCloudWallNotice (JA-21b: Orca Cloud already selected at a billing wall)', () => {
  it('gives an owner the reason and the one fix', () => {
    const notice = orcaCloudWallNotice({
      state: 'out-of-hours',
      cause: 'hours',
      canManageBilling: true
    })
    expect(notice?.reason).toBe('Out of sandbox hours')
    expect(notice?.action?.label).toBe('Turn on overage')
    expect(orcaCloudWallNotice({ state: 'payment-issue', canManageBilling: true })).toMatchObject({
      reason: 'Payment failed',
      action: { label: 'Update payment method' }
    })
    expect(
      orcaCloudWallNotice({ state: 'no-plan', lapsed: true, canManageBilling: true })
    ).toMatchObject({ reason: 'Your Team plan ended', action: { label: 'Renew' } })
  })

  it('gives a member the reason and no action (they ask an owner or admin)', () => {
    const notice = orcaCloudWallNotice({ state: 'payment-issue', canManageBilling: false })
    expect(notice).toEqual({ reason: 'Payment failed', action: null })
  })

  it('has no wall for a usable account or a trial not started yet', () => {
    expect(orcaCloudWallNotice({ state: 'entitled', remainingSeconds: 3600 })).toBeNull()
    expect(orcaCloudWallNotice({ state: 'loading' })).toBeNull()
    expect(
      orcaCloudWallNotice({ state: 'no-plan', lapsed: false, canManageBilling: true })
    ).toBeNull()
  })
})

describe('orcaCloudNeedsFixFirst', () => {
  it('only an owner or admin at a wall must fix first; a trial offer is setup', () => {
    expect(orcaCloudNeedsFixFirst({ state: 'payment-issue', canManageBilling: true })).toBe(true)
    expect(orcaCloudNeedsFixFirst({ state: 'payment-issue', canManageBilling: false })).toBe(false)
    expect(
      orcaCloudNeedsFixFirst({ state: 'no-plan', lapsed: false, canManageBilling: true })
    ).toBe(false)
  })
})

describe('devBillingFaultAccess (dev/QA shots)', () => {
  it('simulates each wall from localStorage, and nothing when unset', () => {
    expect(devBillingFaultAccess()).toBeNull()
    localStorage.setItem('orca:dev:billingFault', 'out-of-hours')
    expect(devBillingFaultAccess()).toMatchObject({ state: 'out-of-hours', canManageBilling: true })
    localStorage.setItem('orca:dev:billingFault', 'lapsed')
    expect(devBillingFaultAccess()).toMatchObject({ state: 'no-plan', lapsed: true })
    localStorage.setItem('orca:dev:billingFault', 'nonsense')
    expect(devBillingFaultAccess()).toBeNull()
  })
})

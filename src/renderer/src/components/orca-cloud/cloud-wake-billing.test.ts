// A wake the plan refused says why in the create sheet's words, offers the fix only to an owner or
// admin (a member reads who to ask), and never shows the control plane's code.
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import { translate } from '@/i18n/i18n'
import { cloudWakeBillingCopy } from './cloud-wake-billing'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

const failed = (reason: string | null, over: Partial<CloudWakeProgressEvent> = {}) =>
  ({
    workspaceId: 'ws',
    phase: 'failed',
    source: 'open',
    startedAt: 1,
    at: 2,
    message: 'entitlement_denied',
    billingDenial: { reason },
    ...over
  }) satisfies CloudWakeProgressEvent

describe('cloudWakeBillingCopy', () => {
  it('is null for a failure the plan did not cause, and while still waking', () => {
    expect(
      cloudWakeBillingCopy({ ...failed(null), billingDenial: undefined }, true, translate)
    ).toBeNull()
    expect(
      cloudWakeBillingCopy(failed('subscription_inactive', { phase: 'waking' }), true, translate)
    ).toBeNull()
  })

  it('an owner or admin gets the fix that applies', () => {
    const fix = (reason: string) => cloudWakeBillingCopy(failed(reason), true, translate)?.fix
    expect(fix('subscription_inactive')).toBe('seePlans')
    expect(fix('included_hours_exhausted')).toBe('seePlans')
    expect(fix('overage_cap_reached')).toBe('raiseSpendCap')
    expect(fix('payment_past_due')).toBe('updatePayment')
  })

  it('a member gets no fix button, and the copy says who to ask', () => {
    const copy = cloudWakeBillingCopy(failed('subscription_inactive'), false, translate)
    expect(copy?.fix).toBeNull()
    expect(copy?.body).toMatch(/Ask an owner or admin/)
    // An owner is never told to ask an owner.
    expect(
      cloudWakeBillingCopy(failed('subscription_inactive'), true, translate)?.body
    ).not.toMatch(/Ask an owner/)
  })

  it('running limits and unknown reasons use the shared copy, with no billing fix', () => {
    expect(cloudWakeBillingCopy(failed('concurrency_limit'), true, translate)?.fix).toBeNull()
    expect(cloudWakeBillingCopy(failed('something_new'), true, translate)?.fix).toBeNull()
  })

  it('never shows the raw code', () => {
    for (const reason of [null, 'subscription_inactive', 'concurrency_limit', 'something_new']) {
      for (const owner of [true, false]) {
        const copy = cloudWakeBillingCopy(failed(reason), owner, translate)
        expect(copy?.body).toBeTruthy()
        expect(copy?.body).not.toMatch(/entitlement|_/)
      }
    }
  })
})

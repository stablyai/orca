import { afterEach, describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import {
  recordBillingStatus,
  resetBillingSummary
} from '@/components/billing/billing-summary-store'
import { sampleOffers, sampleTeam } from '@/components/billing/plan-billing-fixtures'
import { describeError } from './cloud-workspace-errors'

// English defaults with {{slots}} filled, like i18next with no catalog.
const t: Translate = (_key, fallback, params) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_slot, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })

function recordPerSeat(perSeat: number): void {
  recordBillingStatus({
    status: 'ok',
    entitlement: {
      ...sampleTeam,
      offers: {
        ...sampleOffers,
        team: { ...sampleOffers.team, concurrentSandboxesPerSeat: perSeat }
      }
    }
  })
}

describe('describeError for the per-seat running cap', () => {
  afterEach(() => resetBillingSummary())

  it("names the owner's seat when a teammate wakes their workspace", () => {
    recordPerSeat(3)
    expect(
      describeError('entitlement_denied', 'member_concurrency_limit', t, {
        self: false,
        name: 'Alex'
      })
    ).toBe(
      'Alex already has 3 sandboxes running. This workspace runs on their seat, so ask them to put one to sleep, then try again.'
    )
    expect(
      describeError('entitlement_denied', 'member_concurrency_limit', t, {
        self: false,
        name: null
      })
    ).toMatch(/^The workspace owner already has 3 sandboxes running\./)
  })

  it('speaks to the owner about their own seat', () => {
    recordPerSeat(3)
    expect(
      describeError('entitlement_denied', 'member_concurrency_limit', t, { self: true, name: 'Me' })
    ).toBe(
      'You already have 3 sandboxes running, the most one seat can run. Put one to sleep or delete it, then try again.'
    )
  })

  it('says "1 sandbox", not "1 sandboxes", when a seat runs one', () => {
    recordPerSeat(1)
    // i18next picks the _one form for count 1; mirror that here.
    const plural: Translate = (key, fallback, params) =>
      t(
        key,
        params?.count === 1 && typeof params.defaultValue_one === 'string'
          ? params.defaultValue_one
          : fallback,
        params
      )
    expect(
      describeError('entitlement_denied', 'member_concurrency_limit', plural, {
        self: true,
        name: 'Me'
      })
    ).toBe(
      'You already have 1 sandbox running, the most one seat can run. Put it to sleep or delete it, then try again.'
    )
    expect(
      describeError('entitlement_denied', 'member_concurrency_limit', plural, {
        self: false,
        name: 'Alex'
      })
    ).toMatch(/^Alex already has 1 sandbox running\..*put it to sleep/)
  })

  it('falls back to copy without numbers before the plan loads', () => {
    expect(
      describeError('entitlement_denied', 'member_concurrency_limit', t, {
        self: false,
        name: 'Alex'
      })
    ).toBe(
      'Alex is at their limit of running sandboxes. This workspace runs on their seat, so ask them to put one to sleep, then try again.'
    )
  })
})

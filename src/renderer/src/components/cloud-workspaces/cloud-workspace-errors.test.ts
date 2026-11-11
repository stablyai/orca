import { afterEach, describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import {
  recordBillingStatus,
  resetBillingSummary
} from '@/components/billing/billing-summary-store'
import { sampleOffers, sampleTeam } from '@/components/billing/plan-billing-fixtures'
import { isUnknownServerWakeFailure } from '../orca-cloud/CloudWakingOverlay'
import { describeError, isUnknownServerFailure } from './cloud-workspace-errors'

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

describe('unknown server wake failures (shared "Couldn\'t wake the sandbox" copy)', () => {
  it('is a 5xx with no specific copy', () => {
    expect(isUnknownServerFailure('internal_error', 500)).toBe(true)
    expect(isUnknownServerFailure('error', 502)).toBe(true)
    // Known codes keep their own copy; 4xx are never "unknown server".
    expect(isUnknownServerFailure('provider_unavailable', 503)).toBe(false)
    expect(isUnknownServerFailure('entitlement_denied', 500)).toBe(false)
    expect(isUnknownServerFailure('weird', 400)).toBe(false)
    expect(isUnknownServerFailure('weird', undefined)).toBe(false)
  })

  it("recognizes the wake overlay's raw 5xx diagnostics", () => {
    expect(isUnknownServerWakeFailure('Orca Cloud request failed (HTTP 502).')).toBe(true)
    expect(isUnknownServerWakeFailure('Orca Cloud refused the request (internal_error).')).toBe(
      true
    )
    expect(isUnknownServerWakeFailure('Orca Cloud refused the request (conflict).')).toBe(false)
    expect(isUnknownServerWakeFailure('Orca Cloud request failed (HTTP 404).')).toBe(false)
    expect(isUnknownServerWakeFailure(undefined)).toBe(false)
  })
})

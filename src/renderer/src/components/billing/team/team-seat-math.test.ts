import { describe, expect, it } from 'vitest'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import { sampleTeam as activeTeamEntitlement } from '../plan-billing-fixtures'
import { inviteSeatImpact, nextInvoiceEstimate, proratedSeatCents } from './team-seat-math'

const DAY = 86_400_000
const noPlanEntitlement: OrcaBillingEntitlement = {
  ...activeTeamEntitlement,
  plan: null,
  planLabel: null,
  status: 'none',
  interval: null,
  period: null
}

function team(overrides: Partial<OrcaBillingEntitlement> = {}): OrcaBillingEntitlement {
  return {
    ...activeTeamEntitlement,
    interval: 'month',
    seats: 3,
    seatChange: null,
    cancelAtPeriodEnd: false,
    period: { start: 0, end: 30 * DAY },
    ...overrides
  }
}

describe('proratedSeatCents', () => {
  it('charges the remaining share of the period', () => {
    const pricing = { interval: 'month' as const, perSeatPeriodCents: 5000 }
    expect(proratedSeatCents(pricing, { start: 0, end: 30 * DAY }, 15 * DAY)).toBe(2500)
    expect(proratedSeatCents(pricing, { start: 0, end: 30 * DAY }, 31 * DAY)).toBe(0)
    expect(proratedSeatCents(pricing, { start: 0, end: 30 * DAY }, -DAY)).toBe(5000)
  })
})

describe('inviteSeatImpact', () => {
  it('reports no plan when unsubscribed', () => {
    expect(
      inviteSeatImpact({
        entitlement: noPlanEntitlement,
        members: 1,
        pendingInvites: 0,
        newInvites: 2,
        now: 0
      })
    ).toEqual({ kind: 'no-plan' })
  })

  it('uses seats already paid this period first (peak seats)', () => {
    // 3 paid, 1 member: two free seats, so two invites cost nothing.
    expect(
      inviteSeatImpact({
        entitlement: team(),
        members: 1,
        pendingInvites: 0,
        newInvites: 2,
        now: 0
      })
    ).toEqual({ kind: 'covered', freeSeats: 2 })
  })

  it('counts pending invites against free seats before new ones', () => {
    const impact = inviteSeatImpact({
      entitlement: team(),
      members: 2,
      pendingInvites: 1,
      newInvites: 2,
      now: 15 * DAY
    })
    expect(impact).toMatchObject({
      kind: 'adds-seats',
      addedSeats: 2,
      coveredSeats: 0,
      proratedCentsEach: 2500
    })
  })
})

describe('inviteSeatImpact without prices', () => {
  it('still says seats are added (never "covered") when pricing is unknown', () => {
    const unpriced = team({ offers: null })
    expect(
      inviteSeatImpact({
        entitlement: unpriced,
        members: 3,
        pendingInvites: 0,
        newInvites: 2,
        now: 0
      })
    ).toEqual({ kind: 'adds-seats-unpriced', addedSeats: 2 })
  })
})

describe('nextInvoiceEstimate', () => {
  it('bills the renewal seat count, not the period peak', () => {
    const estimate = nextInvoiceEstimate(
      team({ seats: 4, seatChange: { seatsAtRenewal: 2, effectiveAt: 30 * DAY } })
    )
    expect(estimate).toMatchObject({ seats: 2, at: 30 * DAY })
    expect(estimate?.amountCents).toBe(
      2 * (activeTeamEntitlement.offers?.team.monthlyPriceCentsPerSeat ?? 0)
    )
  })

  it('is empty when the plan ends at period end', () => {
    expect(nextInvoiceEstimate(team({ cancelAtPeriodEnd: true }))).toBeNull()
  })
})

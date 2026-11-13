import { describe, expect, it } from 'vitest'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import { sampleTeam as activeTeamEntitlement } from '../plan-billing-fixtures'
import { nextInvoiceEstimate } from './team-seat-math'

const DAY = 86_400_000

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

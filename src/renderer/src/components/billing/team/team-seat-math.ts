// Seat money shown in Plan & billing. Display estimates only: Stripe computes the real invoice.
// Mirrors the billing design: seats billed = the period's peak membership; removals only lower
// seats at renewal.
import type {
  OrcaBillingEntitlement,
  OrcaBillingInterval
} from '../../../../../shared/orca-billing'

export type SeatPricing = {
  interval: OrcaBillingInterval
  /** Price of one seat for one billing period (month or year), in cents. */
  perSeatPeriodCents: number
}

export function seatPricing(entitlement: OrcaBillingEntitlement): SeatPricing | null {
  const team = entitlement.offers?.team
  if (!team || !entitlement.interval) {
    return null
  }
  const cents =
    entitlement.interval === 'year' ? team.annualPriceCentsPerSeat : team.monthlyPriceCentsPerSeat
  return cents === null ? null : { interval: entitlement.interval, perSeatPeriodCents: cents }
}

export function isActivePlan(entitlement: OrcaBillingEntitlement | null): boolean {
  return Boolean(
    entitlement &&
    entitlement.plan !== null &&
    entitlement.status !== 'canceled' &&
    entitlement.status !== 'none' &&
    entitlement.status !== 'incomplete_expired'
  )
}

export type NextInvoiceEstimate = {
  seats: number
  amountCents: number
  at: number
  interval: OrcaBillingInterval
}

/** The renewal invoice before tax and overage: seats drop to the member count at renewal. */
export function nextInvoiceEstimate(
  entitlement: OrcaBillingEntitlement | null
): NextInvoiceEstimate | null {
  if (!entitlement || !isActivePlan(entitlement) || entitlement.cancelAtPeriodEnd) {
    return null
  }
  const pricing = seatPricing(entitlement)
  if (!pricing || !entitlement.period) {
    return null
  }
  const seats = Math.max(1, entitlement.seatChange?.seatsAtRenewal ?? entitlement.seats)
  return {
    seats,
    amountCents: seats * pricing.perSeatPeriodCents,
    at: entitlement.period.end,
    interval: pricing.interval
  }
}

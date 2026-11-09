// Seat money shown on the Team page. Display estimates only: Stripe computes the real invoice.
// Mirrors the billing design: seats billed = the period's peak membership; a member who joins
// above the paid peak is charged now, prorated; removals only lower seats at renewal; pending
// invites cost nothing until accepted.
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

/** One seat for the rest of the current period, rounded to the cent like Stripe's proration. */
export function proratedSeatCents(
  pricing: SeatPricing,
  period: { start: number; end: number },
  now: number
): number {
  const length = period.end - period.start
  if (length <= 0) {
    return pricing.perSeatPeriodCents
  }
  const remaining = Math.min(Math.max(period.end - now, 0), length)
  return Math.round((pricing.perSeatPeriodCents * remaining) / length)
}

export type InviteSeatImpact =
  | { kind: 'no-plan' }
  /** Every new invite fits in seats already paid this period. */
  | { kind: 'covered'; freeSeats: number }
  | {
      kind: 'adds-seats'
      /** How many of the new invites would add a seat when accepted. */
      addedSeats: number
      /** Seats already paid but unused that the first acceptances take for free. */
      coveredSeats: number
      proratedCentsEach: number
      perSeatPeriodCents: number
      interval: OrcaBillingInterval
    }

/**
 * What inviting `newInvites` people costs if they all accept now. Pending invites are assumed to
 * accept first (conservative: never promises a free seat that an earlier invite will take).
 */
export function inviteSeatImpact(args: {
  entitlement: OrcaBillingEntitlement | null
  members: number
  pendingInvites: number
  newInvites: number
  now: number
}): InviteSeatImpact {
  const { entitlement } = args
  if (!entitlement || !isActivePlan(entitlement)) {
    return { kind: 'no-plan' }
  }
  const pricing = seatPricing(entitlement)
  const paidSeats = Math.max(entitlement.seats, 1)
  const freeSeats = Math.max(0, paidSeats - args.members - args.pendingInvites)
  const addedSeats = Math.max(0, args.newInvites - freeSeats)
  if (addedSeats === 0 || !pricing || !entitlement.period) {
    return { kind: 'covered', freeSeats }
  }
  return {
    kind: 'adds-seats',
    addedSeats,
    coveredSeats: Math.min(freeSeats, args.newInvites),
    proratedCentsEach: proratedSeatCents(pricing, entitlement.period, args.now),
    perSeatPeriodCents: pricing.perSeatPeriodCents,
    interval: pricing.interval
  }
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

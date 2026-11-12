// Price math for the plans page. Every number comes from the billing service: its plan catalog
// (Stripe's prices), or an older service's offers.
import type { OrcaBillingInterval } from '../../../../../shared/orca-billing'

/** Per-seat prices in cents; null where billing has no price for that interval. */
type TeamOffer = { monthlyPriceCentsPerSeat: number | null; annualPriceCentsPerSeat: number | null }

/** What one seat costs per month on this interval (annual shown as its monthly equivalent). */
export function perSeatMonthlyCents(team: TeamOffer, interval: OrcaBillingInterval): number | null {
  if (interval === 'month') {
    return team.monthlyPriceCentsPerSeat
  }
  return team.annualPriceCentsPerSeat === null
    ? null
    : Math.round(team.annualPriceCentsPerSeat / 12)
}

/** The amount billed each period for `seats` seats. */
export function periodTotalCents(
  team: TeamOffer,
  interval: OrcaBillingInterval,
  seats: number
): number | null {
  const perSeat =
    interval === 'month' ? team.monthlyPriceCentsPerSeat : team.annualPriceCentsPerSeat
  return perSeat === null ? null : perSeat * Math.max(1, seats)
}

/** Whole-percent saving of annual over twelve monthly payments, or null when not cheaper. */
export function annualSavingsPercent(team: TeamOffer): number | null {
  const monthly = team.monthlyPriceCentsPerSeat
  const annual = team.annualPriceCentsPerSeat
  if (monthly === null || annual === null || monthly <= 0) {
    return null
  }
  const percent = Math.round((1 - annual / (monthly * 12)) * 100)
  return percent > 0 ? percent : null
}

export { formatCents } from '../../../../../shared/orca-billing-usage-alerts'

/** A per-hour rate always shows cents ("$1.00", "$0.75"), unlike whole-dollar prices. */
export function formatRateCents(cents: number, locale: string, currency = 'usd'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(cents / 100)
}

export const MIN_SEATS = 1

export function clampSeats(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return MIN_SEATS
  }
  return Math.min(max, Math.max(MIN_SEATS, Math.round(value)))
}

// Price math for the plans page. Every number comes from the billing service's offers.
import type { OrcaBillingInterval, OrcaBillingOffers } from '../../../../../shared/orca-billing'

type TeamOffer = OrcaBillingOffers['team']

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

/** "$50", "$40", "$0.75", "$1,200" in the given locale. */
export function formatCents(cents: number, locale: string): string {
  const whole = cents % 100 === 0
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2
  }).format(cents / 100)
}

export const MIN_SEATS = 1

export function clampSeats(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return MIN_SEATS
  }
  return Math.min(max, Math.max(MIN_SEATS, Math.round(value)))
}

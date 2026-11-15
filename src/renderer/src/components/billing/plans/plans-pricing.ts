// Price math for the plans dialog. Every number is billing's: its catalog (Stripe's prices), or an
// older service's offers.
import type { OrcaBillingInterval } from '../../../../../shared/orca-billing'

type TeamPrices = {
  monthlyPriceCentsPerSeat: number | null
  annualPriceCentsPerSeat: number | null
}

/** What one seat costs per month on this interval (annual shown as its monthly equivalent). */
export function perSeatMonthlyCents(
  team: TeamPrices,
  interval: OrcaBillingInterval
): number | null {
  if (interval === 'month') {
    return team.monthlyPriceCentsPerSeat
  }
  return team.annualPriceCentsPerSeat === null
    ? null
    : Math.round(team.annualPriceCentsPerSeat / 12)
}

/** Whole-percent saving of annual over twelve monthly payments, or null when not cheaper. */
export function annualSavingsPercent(team: TeamPrices): number | null {
  const monthly = team.monthlyPriceCentsPerSeat
  const annual = team.annualPriceCentsPerSeat
  if (monthly === null || annual === null || monthly <= 0) {
    return null
  }
  const percent = Math.round((1 - annual / (monthly * 12)) * 100)
  return percent > 0 ? percent : null
}

/** The interval to show: the one picked when it is on sale, else the first one that is. */
export function shownInterval(
  picked: OrcaBillingInterval,
  intervals: readonly OrcaBillingInterval[]
): OrcaBillingInterval {
  return intervals.includes(picked) ? picked : (intervals[0] ?? picked)
}

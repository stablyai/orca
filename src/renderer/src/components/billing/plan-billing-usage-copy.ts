// Sandbox-hours lines shared by Plan & billing, the plans page and the account menu, so every
// surface counts, pluralizes and warns the same way.
import type { Translate } from '@/i18n/use-translate'
import type {
  OrcaBillingEntitlement,
  OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import { includedUsagePercent } from './plan-billing-format'
import { isActivePlan } from './team/team-seat-math'

/** The included-hours bar turns to the warning tone from this share of the month's hours. */
export const INCLUDED_HOURS_WARNING_PERCENT = 90

/** Hours as a plural count: one decimal, whole numbers without it (41.5, 78, 1). */
export function sandboxHoursCount(seconds: number): number {
  return Math.round(Math.max(0, seconds) / 360) / 10
}

export function includedUsageTone(entitlement: OrcaBillingEntitlement): 'default' | 'warning' {
  return includedUsagePercent(entitlement) >= INCLUDED_HOURS_WARNING_PERCENT ? 'warning' : 'default'
}

/** "78.5 sandbox hours left" / "1 sandbox hour left". */
export function sandboxHoursLeftLine(entitlement: OrcaBillingEntitlement, t: Translate): string {
  return t('auto.components.billing.sandboxHoursLeftCount', '{{count}} sandbox hours left', {
    count: sandboxHoursCount(entitlement.remainingIncludedSeconds),
    defaultValue_one: '{{count}} sandbox hour left'
  })
}

/** Hours past the included amount this month (billed as overage or not), or 0. */
export function hoursOverIncludedSeconds(entitlement: OrcaBillingEntitlement): number {
  if (entitlement.includedSeconds <= 0) {
    return entitlement.overageSeconds
  }
  return Math.max(entitlement.overageSeconds, entitlement.usedSeconds - entitlement.includedSeconds)
}

/** "3 sandbox hours over the included amount this month", or null when within it. */
export function sandboxHoursOverLine(
  entitlement: OrcaBillingEntitlement,
  t: Translate
): string | null {
  const count = sandboxHoursCount(hoursOverIncludedSeconds(entitlement))
  if (count <= 0) {
    return null
  }
  return t(
    'auto.components.billing.sandboxHoursOverIncluded',
    '{{count}} sandbox hours over the included amount this month',
    {
      count,
      defaultValue_one: '{{count}} sandbox hour over the included amount this month'
    }
  )
}

/**
 * The share of included hours actually used, floored, for the warning sentence: never below the
 * level billing reported (its count may be fresher) and never 100 while hours remain.
 */
export function usedPercentForWarning(entitlement: OrcaBillingEntitlement): number {
  const level = entitlement.usageWarningPercent ?? 0
  const used =
    entitlement.includedSeconds > 0
      ? Math.floor((entitlement.usedSeconds / entitlement.includedSeconds) * 100)
      : level
  return Math.min(99, Math.max(level, used))
}

/**
 * Shown once billing reports a warning level (75%, 90%) until the hours run out; the sentence states
 * the actual share used, not the level. At 100% the bar, the hours-left line and the out-of-hours
 * states say it instead.
 */
export function usageWarningLine(entitlement: OrcaBillingEntitlement, t: Translate): string | null {
  const level = entitlement.usageWarningPercent
  if (level === null || level >= 100) {
    return null
  }
  return t(
    'auto.components.billing.teamUsedPercent',
    'Your team has used {{percent}}% of this month’s sandbox hours.',
    { percent: String(usedPercentForWarning(entitlement)) }
  )
}

/** The account menu's plan lines: hours left, and the early warning once the team reaches it. */
export function accountMenuUsageLines(
  result: OrcaBillingStatusResult | null,
  t: Translate
): { hoursLeft: string; warning: string | null } | null {
  if (result?.status !== 'ok' || !isActivePlan(result.entitlement)) {
    return null
  }
  return {
    hoursLeft: sandboxHoursLeftLine(result.entitlement, t),
    warning: usageWarningLine(result.entitlement, t)
  }
}

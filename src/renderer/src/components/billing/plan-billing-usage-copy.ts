// Sandbox-hours lines shared by Plan & billing, the plans page and the account menu, so every
// surface counts, pluralizes and warns the same way.
import type { Translate } from '@/i18n/use-translate'
import {
  isOrcaCloudTrial,
  type OrcaBillingEntitlement,
  type OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import { usageAlertSentence } from '../../../../shared/orca-billing-usage-alerts'
import {
  includedUsagePercent,
  sandboxHoursAmount,
  sandboxHoursLeft,
  sandboxHoursUsed
} from './plan-billing-format'
import { isActivePlan } from './team/team-seat-math'

/** The included-hours bar turns to the warning tone from this share of the month's hours. */
export const INCLUDED_HOURS_WARNING_PERCENT = 90

/** Hours left as a plural count (41.5, 78, 1): the one rounding every surface uses (JA-07). */
export function sandboxHoursCount(seconds: number): number {
  return sandboxHoursLeft(seconds)
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
  const count = sandboxHoursUsed(hoursOverIncludedSeconds(entitlement))
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
 * The usage alert for owners and admins (75%, 90%: the share used; 100%: what happens next). The
 * same sentence goes out as the desktop notification. Members aren't alerted, so they don't see it.
 */
export function usageWarningLine(
  entitlement: OrcaBillingEntitlement,
  t: Translate,
  locale: string
): string | null {
  return usageAlertSentence(entitlement, t, locale)
}

/** The account menu's plan lines: hours left, and the early warning once the team reaches it. */
export function accountMenuUsageLines(
  result: OrcaBillingStatusResult | null,
  t: Translate,
  locale: string
): { hoursLeft: string; warning: string | null } | null {
  if (result?.status !== 'ok' || !isActivePlan(result.entitlement)) {
    return null
  }
  return {
    hoursLeft: sandboxHoursLeftLine(result.entitlement, t),
    warning: usageWarningLine(result.entitlement, t, locale)
  }
}

/** "0.6 of 2 sandbox hours used": the trial's hours never reset, so no "this month". */
export function trialHoursUsedLine(entitlement: OrcaBillingEntitlement, t: Translate): string {
  return t('auto.components.billing.trialHoursUsed', '{{used}} of {{count}} sandbox hours used', {
    used: String(sandboxHoursUsed(Math.min(entitlement.usedSeconds, entitlement.includedSeconds))),
    count: sandboxHoursAmount(entitlement.includedSeconds),
    defaultValue_one: '{{used}} of {{count}} sandbox hour used'
  })
}

/** "Trial · 1.4 sandbox hours left" (glossary hint), for the account menu and the composer. */
export function trialHoursLeftHint(entitlement: OrcaBillingEntitlement, t: Translate): string {
  return t('auto.components.billing.trialHoursLeft', 'Trial · {{count}} sandbox hours left', {
    count: sandboxHoursCount(entitlement.remainingIncludedSeconds),
    defaultValue_one: 'Trial · {{count}} sandbox hour left'
  })
}

/**
 * The account menu's trial row (spec T1): every member sees it while the team is on its trial;
 * owners and admins also get Choose plan. Gone once a plan starts (the entitlement has no trial).
 */
export function accountMenuTrialRow(
  result: OrcaBillingStatusResult | null,
  t: Translate
): { label: string; usedUp: boolean; canChoosePlan: boolean } | null {
  if (result?.status !== 'ok' || !isOrcaCloudTrial(result.entitlement)) {
    return null
  }
  const entitlement = result.entitlement
  const usedUp = entitlement.trial?.exhausted === true
  return {
    label: usedUp
      ? t('auto.components.billing.trialUsedUpTitle', 'Your trial is used up')
      : trialHoursLeftHint(entitlement, t),
    usedUp,
    canChoosePlan: entitlement.canManageBilling
  }
}

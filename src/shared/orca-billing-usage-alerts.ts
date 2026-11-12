// Usage alerts for owners and admins: the in-app notice and the desktop notification both come
// from billing's usageWarningPercent, so they always agree on the level and the percent.
import type { OrcaBillingEntitlement } from './orca-billing'

/**
 * The included-hours levels owners and admins are alerted at, from billing's plan (ascending);
 * null from older services, which then alert at each level billing reports.
 */
export function usageAlertLevels(entitlement: OrcaBillingEntitlement): number[] | null {
  const levels = entitlement.offers?.team.warnAtPercent
  return levels && levels.length > 0 ? [...levels].sort((a, b) => a - b) : null
}

/**
 * The share of included hours actually used, floored, for the warning sentence: never below the
 * level billing reported (its count may be fresher) and never 100 while hours remain.
 */
export function usageWarningUsedPercent(entitlement: OrcaBillingEntitlement): number {
  const level = entitlement.usageWarningPercent ?? 0
  const used =
    entitlement.includedSeconds > 0
      ? Math.floor((entitlement.usedSeconds / entitlement.includedSeconds) * 100)
      : level
  return Math.min(99, Math.max(level, used))
}

/** The highest alert level the team has reached, or null below 75% (or with no warning). */
export function usageAlertLevel(entitlement: OrcaBillingEntitlement): number | null {
  if (entitlement.usageWarningPercent === null) {
    return null
  }
  const levels = usageAlertLevels(entitlement)
  if (!levels) {
    return entitlement.usageWarningPercent
  }
  const used = Math.max(
    entitlement.usageWarningPercent,
    entitlement.includedSeconds > 0
      ? Math.floor((entitlement.usedSeconds / entitlement.includedSeconds) * 100)
      : 0
  )
  let reached: number | null = null
  for (const level of levels) {
    if (used >= level) {
      reached = level
    }
  }
  return reached
}

/** The start of the window the hours count against: levels reset when it rolls over. */
export function usageAlertPeriodStart(entitlement: OrcaBillingEntitlement): number | null {
  return entitlement.usageWindow?.start ?? entitlement.period?.start ?? null
}

/** Levels already notified, per account (`${userId}:${orgId}`) and billing period. */
export type UsageAlertLedger = Record<string, { periodStart: number; levels: number[] }>

export type UsageAlertDecision = {
  /** The notification to show, or null. */
  notify: { level: number; percent: number } | null
  /** The ledger to persist (the same object when nothing changed). */
  ledger: UsageAlertLedger
}

/**
 * Decides whether a billing read crosses a new alert level for this account and period. Only
 * owners and admins are alerted, once per level per period; crossing several levels at once sends
 * one notification for the highest and marks the lower ones done. A new period starts empty.
 */
export function decideUsageAlert(
  ledger: UsageAlertLedger,
  accountKey: string,
  entitlement: OrcaBillingEntitlement
): UsageAlertDecision {
  const unchanged: UsageAlertDecision = { notify: null, ledger }
  if (!entitlement.canManageBilling) {
    return unchanged
  }
  const periodStart = usageAlertPeriodStart(entitlement)
  const level = usageAlertLevel(entitlement)
  if (periodStart === null || level === null) {
    return unchanged
  }
  const entry = ledger[accountKey]
  const notified = entry && entry.periodStart === periodStart ? entry.levels : []
  // At or below a level already sent this period (lower levels count as passed with it).
  if (notified.some((sent) => sent >= level)) {
    return unchanged
  }
  const known = usageAlertLevels(entitlement)
  const levels = known
    ? known.filter((l) => l <= level || notified.includes(l))
    : [...new Set([...notified, level])].sort((a, b) => a - b)
  return {
    notify: { level, percent: level >= 100 ? 100 : usageWarningUsedPercent(entitlement) },
    ledger: { ...ledger, [accountKey]: { periodStart, levels: [...levels] } }
  }
}

/** "$50", "$25", "$0.75" in the given locale (shared by the plans page and the usage alert). */
export function formatCents(cents: number, locale: string): string {
  const whole = cents % 100 === 0
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2
  }).format(cents / 100)
}

type UsageAlertTranslate = (
  key: string,
  fallback: string,
  options?: Record<string, string>
) => string

/**
 * The alert sentence for the in-app notice and the desktop notification alike, or null when there
 * is nothing to say (no level reached, or a member: members aren't alerted). At 75% and 90% it
 * states the share used; at 100% it says what happens next, which depends on overage.
 */
export function usageAlertSentence(
  entitlement: OrcaBillingEntitlement,
  t: UsageAlertTranslate,
  locale: string
): string | null {
  if (!entitlement.canManageBilling) {
    return null
  }
  const level = usageAlertLevel(entitlement)
  if (level === null) {
    return null
  }
  if (level < 100) {
    return t(
      'auto.components.billing.teamUsedPercent',
      'Your team has used {{percent}}% of this month’s sandbox hours.',
      { percent: String(usageWarningUsedPercent(entitlement)) }
    )
  }
  return entitlement.overage.optedIn
    ? t(
        'auto.components.billing.teamUsedAllOverageOn',
        'Your team has used all of this month’s sandbox hours. Overage is on, up to your {{cap}} spend cap.',
        { cap: formatCents(entitlement.overage.spendCapCents, locale) }
      )
    : t(
        'auto.components.billing.teamUsedAllOverageOff',
        'Your team has used all of this month’s sandbox hours. Running sandboxes go to sleep and new ones can’t start. Turn on overage to keep going.'
      )
}

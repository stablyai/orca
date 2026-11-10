// Usage alerts for owners and admins: the in-app notice and the desktop notification both come
// from billing's usageWarningPercent, so they always agree on the level and the percent.
import type { OrcaBillingEntitlement } from './orca-billing'

/** The included-hours levels owners and admins are alerted at. */
export const ORCA_USAGE_ALERT_LEVELS = [75, 90, 100] as const

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
  const used = Math.max(
    entitlement.usageWarningPercent,
    entitlement.includedSeconds > 0
      ? Math.floor((entitlement.usedSeconds / entitlement.includedSeconds) * 100)
      : 0
  )
  let reached: number | null = null
  for (const level of ORCA_USAGE_ALERT_LEVELS) {
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
  if (notified.includes(level)) {
    return unchanged
  }
  const levels = ORCA_USAGE_ALERT_LEVELS.filter((l) => l <= level || notified.includes(l))
  return {
    notify: { level, percent: level >= 100 ? 100 : usageWarningUsedPercent(entitlement) },
    ledger: { ...ledger, [accountKey]: { periodStart, levels: [...levels] } }
  }
}

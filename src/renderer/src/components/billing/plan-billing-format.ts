import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'

/** Hours with at most one decimal; whole numbers drop the decimal. */
export function formatHours(seconds: number): string {
  const hours = Math.max(0, seconds) / 3600
  const rounded = Math.round(hours * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** Percent of included hours used, clamped to 0..100 (overage shows as full). */
export function includedUsagePercent(entitlement: OrcaBillingEntitlement): number {
  if (entitlement.includedSeconds <= 0) {
    return 0
  }
  return Math.min(100, Math.round((entitlement.usedSeconds / entitlement.includedSeconds) * 100))
}

export type PlanBillingTone = 'ok' | 'warning' | 'blocked'

export function planBillingTone(entitlement: OrcaBillingEntitlement): PlanBillingTone {
  if (!entitlement.canStartSandbox) {
    return 'blocked'
  }
  return entitlement.remainingIncludedSeconds === 0 || entitlement.cancelAtPeriodEnd
    ? 'warning'
    : 'ok'
}

/** "$0.75", "$25" — whole dollars drop the cents. */
export function formatDollars(cents: number): string {
  const dollars = Math.max(0, cents) / 100
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

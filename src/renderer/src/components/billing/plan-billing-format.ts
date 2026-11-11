import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'

// One rounding rule for sandbox hours on every surface (JA-07: home, billing, composer and the
// account menu showed four different numbers). Tenths of an hour; "left" rounds down and "used"
// rounds up, so the two always add up to the included amount and "left" never overstates.

/** Absorbs float noise (177.4 h is 1773.9999… tenths) without moving a real boundary. */
const TENTHS_EPSILON = 1e-6

/** Hours left, in tenths, rounded down. The last few minutes read 0.1, not a misleading 0. */
export function sandboxHoursLeft(seconds: number): number {
  if (seconds <= 0) {
    return 0
  }
  return Math.max(0.1, Math.floor(seconds / 360 + TENTHS_EPSILON) / 10)
}

/** Hours used, in tenths, rounded up (any use at all reads at least 0.1). */
export function sandboxHoursUsed(seconds: number): number {
  if (seconds <= 0) {
    return 0
  }
  return Math.ceil(seconds / 360 - TENTHS_EPSILON) / 10
}

/** An amount of hours (included, offered), in tenths, rounded to nearest. */
export function sandboxHoursAmount(seconds: number): number {
  return Math.round(Math.max(0, seconds) / 360) / 10
}

/** Hours with at most one decimal; whole numbers drop the decimal. */
export function formatHours(seconds: number): string {
  return formatHoursNumber(sandboxHoursAmount(seconds))
}

/** Used hours as text, rounded up like `sandboxHoursUsed`. */
export function formatHoursUsed(seconds: number): string {
  return formatHoursNumber(sandboxHoursUsed(seconds))
}

function formatHoursNumber(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
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

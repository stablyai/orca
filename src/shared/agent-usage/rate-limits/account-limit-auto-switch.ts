import type { ProviderRateLimits } from './rate-limit-types'

export const DEFAULT_ACCOUNT_AUTO_SWITCH_THRESHOLD_PERCENT = 95

export type AccountLimitCandidate = {
  accountId: string
  limits: ProviderRateLimits | null | undefined
}

export type AccountLimitSwitchDecision =
  | { kind: 'under-limit' }
  | { kind: 'switch'; accountId: string; usedPercent: number }
  | { kind: 'no-account-under-limit' }

/** The most spent window that blocks every model; null without a successful reading. */
export function accountLimitUsedPercent(
  limits: ProviderRateLimits | null | undefined
): number | null {
  if (!limits || limits.status !== 'ok') {
    return null
  }
  // Why these windows: model-only ones (Fable, buckets) leave other models usable.
  const spent = [limits.session, limits.weekly, limits.monthly].flatMap((window) =>
    window && Number.isFinite(window.usedPercent) ? [window.usedPercent] : []
  )
  return spent.length > 0 ? Math.max(...spent) : null
}

export function resolveAccountAutoSwitchThreshold(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_ACCOUNT_AUTO_SWITCH_THRESHOLD_PERCENT
  }
  return Math.min(100, Math.max(1, Math.round(value)))
}

/** Unknown usage never triggers a switch and is never switched to. */
export function decideAccountLimitSwitch(args: {
  active: ProviderRateLimits | null | undefined
  thresholdPercent: number
  candidates: readonly AccountLimitCandidate[]
}): AccountLimitSwitchDecision {
  const activeUsed = accountLimitUsedPercent(args.active)
  if (activeUsed === null || activeUsed < args.thresholdPercent) {
    return { kind: 'under-limit' }
  }
  let best: { accountId: string; usedPercent: number } | null = null
  for (const candidate of args.candidates) {
    const used = accountLimitUsedPercent(candidate.limits)
    if (used !== null && used < args.thresholdPercent && (!best || used < best.usedPercent)) {
      best = { accountId: candidate.accountId, usedPercent: used }
    }
  }
  return best ? { kind: 'switch', ...best } : { kind: 'no-account-under-limit' }
}

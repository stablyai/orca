import type { ExtraUsageBalance, ProviderRateLimits } from './rate-limit-types'

function overageCarriesTurns(extra: ExtraUsageBalance | null | undefined): boolean {
  if (!extra?.enabled) {
    return false
  }
  if (extra.unit === 'credits') {
    return extra.unlimited || extra.balance > 0
  }
  return extra.spentPercent !== null ? extra.spentPercent < 100 : (extra.balance ?? 0) > 0
}

/** When the account's spent windows all reset: undefined when none blocks every model, null when
 *  one does but its reset is unknown. Model-only windows (Fable, buckets) never block all turns. */
export function rateLimitSpentUntil(limits: ProviderRateLimits): number | null | undefined {
  if (overageCarriesTurns(limits.extraUsage)) {
    return undefined
  }
  let until: number | null | undefined
  for (const window of [limits.session, limits.weekly, limits.monthly]) {
    if (!window || window.usedPercent < 100) {
      continue
    }
    if (window.resetsAt === null || !Number.isFinite(window.resetsAt)) {
      return null
    }
    until = Math.max(until ?? window.resetsAt, window.resetsAt)
  }
  return until
}

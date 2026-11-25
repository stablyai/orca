import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { clampUsedPercent } from '../../../../../shared/agent-usage/display/usage-percentage-display'

// Treat 99.5% as capped to tolerate rounding before revealing spendable overage.
const CAP_THRESHOLD_PERCENT = 99.5

export function isExtraUsageActive(p: ProviderRateLimits): boolean {
  if (
    !p.extraUsage ||
    !p.extraUsage.enabled ||
    (p.extraUsage.unit === 'currency' &&
      (p.extraUsage.balance === null || p.extraUsage.balance <= 0))
  ) {
    return false
  }
  // Command Code's credit balance is its primary reading, not a cap-triggered overage.
  if (p.provider === 'command-code') {
    return true
  }
  return [p.session, p.weekly, p.monthly, p.fableWeekly].some(
    (w) => w != null && clampUsedPercent(w.usedPercent) >= CAP_THRESHOLD_PERCENT
  )
}

import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

// Why: Codex reset credits were only visible in the expanded panel; the always-on
// status-bar segment now surfaces the available count so users see spendable
// resets at a glance, without opening the roster.
export function getInlineResetCreditCount(p: ProviderRateLimits | null): number | null {
  if (!p || p.provider !== 'codex') {
    return null
  }
  const count = p.rateLimitResetCredits?.availableCount
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : null
}

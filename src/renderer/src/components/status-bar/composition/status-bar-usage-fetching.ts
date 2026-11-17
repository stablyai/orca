import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

/** True while any usage provider's snapshot is still being fetched (drives the refresh spinner). */
export function isAnyUsageProviderFetching(rateLimits: RateLimitState): boolean {
  return [
    rateLimits.claude,
    rateLimits.codex,
    rateLimits.gemini,
    rateLimits.opencodeGo,
    rateLimits.kimi,
    rateLimits.antigravity,
    rateLimits.minimax,
    rateLimits.grok,
    rateLimits.cursor,
    rateLimits.zcode,
    rateLimits.muse
  ].some((provider) => provider?.status === 'fetching')
}

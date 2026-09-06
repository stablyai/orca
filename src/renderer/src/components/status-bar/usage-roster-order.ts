import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

export type UsageRosterSlots = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  zai: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  antigravity: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
  kimi: ProviderRateLimits | null
  minimax: ProviderRateLimits | null
  grok: ProviderRateLimits | null
}

// Why: the footer roster's provider order is a product decision (Claude, Codex,
// Z.AI, then the remaining providers), so it lives in one testable place.
export function buildUsageRosterProviders(slots: UsageRosterSlots): ProviderRateLimits[] {
  return [
    slots.claude,
    slots.codex,
    slots.zai,
    slots.gemini,
    slots.antigravity,
    slots.opencodeGo,
    slots.kimi,
    slots.minimax,
    slots.grok
  ].filter((p): p is ProviderRateLimits => p !== null)
}

import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

function hasUsageData(provider: ProviderRateLimits): boolean {
  return Boolean(
    provider.session ||
    provider.weekly ||
    provider.monthly ||
    (provider.buckets && provider.buckets.length > 0)
  )
}

// Why: a provider that returns `unavailable` is explicitly not configured
// (Gemini OAuth off, OpenCode Go cookie unset, Claude on API-key billing). Its
// fetch object is non-null, so a bare `!== null` check still renders a "--"
// bar for a provider the user never set up. `error` is kept visible on purpose
// — that's a *configured* provider failing transiently, and hiding it would
// make the bar flap on every refresh hiccup.
export function isProviderConfigured(
  provider: ProviderRateLimits | null
): provider is ProviderRateLimits {
  if (provider === null || provider.status === 'unavailable') {
    return false
  }
  if (provider.status === 'fetching' && !hasUsageData(provider)) {
    return false
  }
  return true
}

import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { StatusBarUsageWindows } from '../../../../shared/status-bar-usage-windows'

export function selectStatusBarProviderWindows(
  provider: ProviderRateLimits,
  windows: StatusBarUsageWindows
): ProviderRateLimits {
  if (
    windows === 'both' ||
    provider.buckets?.length ||
    (!provider.session && !provider.weekly && !provider.fableWeekly)
  ) {
    return provider
  }

  return {
    ...provider,
    session: windows === 'session' ? provider.session : null,
    weekly: windows === 'weekly' ? provider.weekly : null,
    fableWeekly: windows === 'weekly' ? provider.fableWeekly : null,
    // Do not substitute a monthly limit for an absent selected window.
    monthly: null
  }
}

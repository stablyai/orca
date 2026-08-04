import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

/**
 * True when a snapshot exists but carries no usable window, which is what a
 * failed credential read looks like: `status: 'error'` with every window null.
 */
export function isUnavailableInactiveUsage(limits: ProviderRateLimits | null | undefined): boolean {
  return limits?.status === 'error' && !limits.session && !limits.weekly && !limits.fableWeekly
}

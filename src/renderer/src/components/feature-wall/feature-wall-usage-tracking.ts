import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

export type FeatureWallUsageProviderConnection = {
  connected: boolean
  label: string
}

export function hasFeatureWallProviderUsageTracking(provider: ProviderRateLimits | null): boolean {
  if (!provider) {
    return false
  }
  return (
    provider.status === 'ok' ||
    provider.session !== null ||
    provider.weekly !== null ||
    (provider.buckets?.length ?? 0) > 0
  )
}

export function getFeatureWallUsageProviderConnection(args: {
  managedAccountCount: number
  provider: ProviderRateLimits | null
}): FeatureWallUsageProviderConnection {
  if (args.managedAccountCount > 0) {
    return { connected: true, label: `Connected · ${args.managedAccountCount}` }
  }
  if (hasFeatureWallProviderUsageTracking(args.provider)) {
    return { connected: true, label: 'Connected · System default' }
  }
  return { connected: false, label: 'Tracking not set up' }
}

export function hasFeatureWallUsageTracking(args: {
  claudeManagedAccountCount: number
  codexManagedAccountCount: number
  claudeRateLimits: ProviderRateLimits | null
  codexRateLimits: ProviderRateLimits | null
}): boolean {
  return (
    args.claudeManagedAccountCount > 0 ||
    args.codexManagedAccountCount > 0 ||
    hasFeatureWallProviderUsageTracking(args.claudeRateLimits) ||
    hasFeatureWallProviderUsageTracking(args.codexRateLimits)
  )
}

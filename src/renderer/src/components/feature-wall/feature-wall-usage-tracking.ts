import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'

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
    return { connected: true, label: translate("auto.components.feature.wall.feature.wall.usage.tracking.00087eecb2", "Connected · {{value0}}", { value0: args.managedAccountCount }) }
  }
  if (hasFeatureWallProviderUsageTracking(args.provider)) {
    return { connected: true, label: translate("auto.components.feature.wall.feature.wall.usage.tracking.cc39a87288", "Connected · System default") }
  }
  return { connected: false, label: translate("auto.components.feature.wall.feature.wall.usage.tracking.b94ec70eda", "Tracking not set up") }
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

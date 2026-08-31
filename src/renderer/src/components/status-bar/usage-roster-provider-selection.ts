import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import {
  getVisibleUsageProvider,
  type UsageProviderSettings
} from './status-bar-provider-visibility'

type UsageProviderId = ProviderRateLimits['provider']

export type UsageProviderSnapshots = Record<UsageProviderId, ProviderRateLimits | null>

export function isAntigravityUsageConfigured(detectedAgentIds: TuiAgent[] | null): boolean {
  return isStatusBarItemAvailable('antigravity', detectedAgentIds)
}

// Why: the roster order stays stable even when providers are pinned or unpinned.
export const USAGE_ROSTER_PROVIDER_ORDER: readonly UsageProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok'
]

export function getUsageRosterProviders(args: {
  snapshots: UsageProviderSnapshots
  settings: Partial<UsageProviderSettings> | null | undefined
}): ProviderRateLimits[] {
  return USAGE_ROSTER_PROVIDER_ORDER.map((providerId) =>
    getVisibleUsageProvider(providerId, args.snapshots[providerId], args.settings)
  ).filter((provider): provider is ProviderRateLimits => provider !== null)
}

export function getPinnedUsageProviders(args: {
  rosterProviders: ProviderRateLimits[]
  statusBarItems: StatusBarItem[]
  detectedAgentIds: TuiAgent[] | null
}): ProviderRateLimits[] {
  return args.rosterProviders.filter(
    (provider) =>
      args.statusBarItems.includes(provider.provider) &&
      isStatusBarItemAvailable(provider.provider, args.detectedAgentIds)
  )
}

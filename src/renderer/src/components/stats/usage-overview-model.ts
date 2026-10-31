import { buildDailyOverview, countActiveDays } from './usage-overview-daily-series'
import type {
  UsageOverviewDailyPoint,
  UsageOverviewInput,
  UsageOverviewModel
} from './usage-overview-types'
import {
  createClaudeProvider,
  createCodexProvider,
  createMuseProvider,
  createOpenCodeProvider
} from './usage-provider-normalization'
export {
  formatCost as formatUsageCost,
  formatTokens as formatUsageTokens
} from './usage-formatters'

export function buildUsageOverview(input: UsageOverviewInput): UsageOverviewModel {
  const providers = [
    createClaudeProvider(input.claude),
    createCodexProvider(input.codex),
    createOpenCodeProvider(input.opencode),
    createMuseProvider(input.muse)
  ]
  const daily = buildDailyOverview(input)
  const bestDay =
    daily.length === 0
      ? null
      : daily.reduce<UsageOverviewDailyPoint | null>(
          (best, entry) => (!best || entry.totalTokens > best.totalTokens ? entry : best),
          null
        )
  const totalTokens = providers.reduce((sum, provider) => sum + provider.totalTokens, 0)
  const newInputTokens = providers.reduce((sum, provider) => sum + provider.newInputTokens, 0)
  const outputTokens = providers.reduce((sum, provider) => sum + provider.outputTokens, 0)
  const cacheTokens = providers.reduce((sum, provider) => sum + provider.cacheTokens, 0)
  const reasoningTokens = providers.reduce((sum, provider) => sum + provider.reasoningTokens, 0)
  const sessions = providers.reduce((sum, provider) => sum + provider.sessions, 0)
  const activityCount = providers.reduce((sum, provider) => sum + provider.activityCount, 0)
  const knownCost = providers.reduce((sum, provider) => sum + (provider.estimatedCostUsd ?? 0), 0)
  const hasKnownCost = providers.some((provider) => provider.estimatedCostUsd !== null)
  // Why: with no priced provider the total already reads n/a; "some prices unavailable" would mislead.
  const hasPartialCost =
    hasKnownCost &&
    providers.some(
      (provider) =>
        provider.hasPartialCost || (provider.hasData && provider.estimatedCostUsd === null)
    )
  const lastUpdatedAt =
    providers.reduce<number | null>(
      (latest, provider) =>
        provider.lastScanCompletedAt && (!latest || provider.lastScanCompletedAt > latest)
          ? provider.lastScanCompletedAt
          : latest,
      null
    ) ?? null

  return {
    providers,
    enabledProviderCount: providers.filter((provider) => provider.enabled).length,
    dataProviderCount: providers.filter((provider) => provider.hasData).length,
    hasAnyEnabledProvider: providers.some((provider) => provider.enabled),
    hasAnyData: providers.some((provider) => provider.hasData),
    totalTokens,
    newInputTokens,
    outputTokens,
    cacheTokens,
    reasoningTokens,
    sessions,
    activityCount,
    activeDays: countActiveDays(
      daily.filter((entry) => entry.totalTokens > 0).map((entry) => entry.day)
    ),
    estimatedCostUsd: hasKnownCost ? knownCost : null,
    hasPartialCost,
    cacheShare:
      newInputTokens + cacheTokens > 0 ? cacheTokens / (newInputTokens + cacheTokens) : null,
    daily,
    bestDay,
    lastUpdatedAt
  }
}

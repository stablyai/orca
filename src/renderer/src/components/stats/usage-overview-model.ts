import { buildDailyOverview, countActiveDays } from './usage-overview-daily-series'
import type {
  UsageOverviewDailyPoint,
  UsageOverviewInput,
  UsageOverviewModel
} from './usage-overview-types'
import {
  createClaudeProvider,
  createCodexProvider,
  createOpenCodeProvider
} from './usage-provider-normalization'

export function buildUsageOverview(input: UsageOverviewInput): UsageOverviewModel {
  const providers = [
    createClaudeProvider(input.claude),
    createCodexProvider(input.codex),
    createOpenCodeProvider(input.opencode)
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
  const hasPartialCost = providers.some(
    (provider) => provider.hasData && provider.estimatedCostUsd === null
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

export function formatUsageTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return value.toLocaleString()
}

export function formatUsageCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

import type { CodexUsageSummary } from '../../../../shared/codex-usage-types'
import type { OpenCodeUsageSummary } from '../../../../shared/opencode-usage-types'
import { countActiveDays, getClaudeDailyTotal } from './usage-overview-daily-series'
import type { UsageOverviewInput, UsageProviderOverview } from './usage-overview-types'
import { translate } from '@/i18n/i18n'

function getCodexNewInputTokens(summary: CodexUsageSummary | null): number {
  if (!summary) {
    return 0
  }
  return Math.max(summary.inputTokens - summary.cachedInputTokens, 0)
}

function getOpenCodeNewInputTokens(summary: OpenCodeUsageSummary | null): number {
  if (!summary) {
    return 0
  }
  return Math.max(summary.inputTokens - summary.cachedInputTokens, 0)
}

export function createClaudeProvider(input: UsageOverviewInput['claude']): UsageProviderOverview {
  const summary = input.summary
  const dailyActiveDays = input.daily
    .filter((entry) => getClaudeDailyTotal(entry) > 0)
    .map((entry) => entry.day)
  return {
    id: 'claude',
    label: translate('auto.components.stats.usage.overview.model.544d6d4c16', 'Claude'),
    enabled: input.scanState?.enabled ?? false,
    isScanning: input.scanState?.isScanning ?? false,
    hasData: summary?.hasAnyClaudeData ?? input.scanState?.hasAnyClaudeData ?? false,
    lastScanCompletedAt: input.scanState?.lastScanCompletedAt ?? null,
    lastScanError: input.scanState?.lastScanError ?? null,
    sessions: summary?.sessions ?? 0,
    activityLabel: 'turns',
    activityCount: summary?.turns ?? 0,
    totalTokens: summary
      ? summary.inputTokens +
        summary.outputTokens +
        summary.cacheReadTokens +
        summary.cacheWriteTokens
      : 0,
    newInputTokens: summary?.inputTokens ?? 0,
    outputTokens: summary?.outputTokens ?? 0,
    cacheTokens: summary ? summary.cacheReadTokens + summary.cacheWriteTokens : 0,
    reasoningTokens: 0,
    estimatedCostUsd: summary?.estimatedCostUsd ?? null,
    topModel: summary?.topModel ?? null,
    topProject: summary?.topProject ?? null,
    activeDays: countActiveDays(dailyActiveDays)
  }
}

export function createCodexProvider(input: UsageOverviewInput['codex']): UsageProviderOverview {
  const summary = input.summary
  const dailyActiveDays = input.daily
    .filter((entry) => entry.totalTokens > 0)
    .map((entry) => entry.day)
  return {
    id: 'codex',
    label: translate('auto.components.stats.usage.overview.model.eb220d193b', 'Codex'),
    enabled: input.scanState?.enabled ?? false,
    isScanning: input.scanState?.isScanning ?? false,
    hasData: summary?.hasAnyCodexData ?? input.scanState?.hasAnyCodexData ?? false,
    lastScanCompletedAt: input.scanState?.lastScanCompletedAt ?? null,
    lastScanError: input.scanState?.lastScanError ?? null,
    sessions: summary?.sessions ?? 0,
    activityLabel: 'events',
    activityCount: summary?.events ?? 0,
    totalTokens: summary?.totalTokens ?? 0,
    newInputTokens: getCodexNewInputTokens(summary),
    outputTokens: summary?.outputTokens ?? 0,
    cacheTokens: summary?.cachedInputTokens ?? 0,
    reasoningTokens: summary?.reasoningOutputTokens ?? 0,
    estimatedCostUsd: summary?.estimatedCostUsd ?? null,
    topModel: summary?.topModel ?? null,
    topProject: summary?.topProject ?? null,
    activeDays: countActiveDays(dailyActiveDays)
  }
}

export function createOpenCodeProvider(
  input: UsageOverviewInput['opencode']
): UsageProviderOverview {
  const summary = input.summary
  const dailyActiveDays = input.daily
    .filter((entry) => entry.totalTokens > 0)
    .map((entry) => entry.day)
  return {
    id: 'opencode',
    label: translate('auto.components.stats.usage.overview.model.bc474051e5', 'OpenCode'),
    enabled: input.scanState?.enabled ?? false,
    isScanning: input.scanState?.isScanning ?? false,
    hasData: summary?.hasAnyOpenCodeData ?? input.scanState?.hasAnyOpenCodeData ?? false,
    lastScanCompletedAt: input.scanState?.lastScanCompletedAt ?? null,
    lastScanError: input.scanState?.lastScanError ?? null,
    sessions: summary?.sessions ?? 0,
    activityLabel: 'events',
    activityCount: summary?.events ?? 0,
    totalTokens: summary?.totalTokens ?? 0,
    newInputTokens: getOpenCodeNewInputTokens(summary),
    outputTokens: summary?.outputTokens ?? 0,
    cacheTokens: summary?.cachedInputTokens ?? 0,
    reasoningTokens: summary?.reasoningOutputTokens ?? 0,
    estimatedCostUsd: summary?.estimatedCostUsd ?? null,
    topModel: summary?.topModel ?? null,
    topProject: summary?.topProject ?? null,
    activeDays: countActiveDays(dailyActiveDays)
  }
}

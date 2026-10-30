import type {
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint
} from '../../../../shared/claude-usage-types'
import type { OmpUsageBreakdownRow, OmpUsageDailyPoint } from '../../../../shared/omp-usage-types'
import { translate } from '@/i18n/i18n'
import type { UsageProviderId } from '../stats/usage-overview-types'
import type {
  UsageDashboardDailyPoint,
  UsageDashboardModelRowInput
} from './usage-dashboard-series'

export type DashboardProviderId = 'claude' | 'codex' | 'opencode' | 'muse' | 'omp'
/** Drawer period selector values; 14 maps onto the 30-day provider buckets and is trimmed locally. */
export type DashboardPeriod = 7 | 14 | 30
/** The drawer's own scope/range unions; every provider API accepts these literals. */
export type DashboardScope = 'orca' | 'all'
export type DashboardRange = '7d' | '30d' | '90d' | 'all'

export type DashboardProviderData = {
  id: UsageProviderId
  daily: UsageDashboardDailyPoint[]
  models: UsageDashboardModelRowInput[]
}

/** Fixed order keeps the chart legend, table groups and provider rows stable across renders. */
export const DASHBOARD_PROVIDER_IDS: readonly DashboardProviderId[] = [
  'claude',
  'codex',
  'opencode',
  'muse',
  'omp'
]

/** Codex/OpenCode/Muse report a cached subset of input, so uncached input is the remainder. */
type CachedInputPoint = {
  day: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

type CachedInputModelRow = {
  label: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  estimatedCostUsd?: number | null
}

function unknownModelLabel(): string {
  return translate('auto.components.stats.OpenCodeUsagePane.362231082f', 'Unknown')
}

function fromCachedInputDaily(points: readonly CachedInputPoint[]): UsageDashboardDailyPoint[] {
  return points.map((point) => ({
    day: point.day,
    inputTokens: Math.max(point.inputTokens - point.cachedInputTokens, 0),
    outputTokens: point.outputTokens,
    cacheReadTokens: point.cachedInputTokens,
    cacheWriteTokens: 0,
    ...(point.reasoningOutputTokens > 0 ? { reasoningTokens: point.reasoningOutputTokens } : {}),
    // Only omp records per-message cost, so these providers price nothing at the day level.
    costUsd: 0
  }))
}

function fromCachedInputModels(
  rows: readonly CachedInputModelRow[]
): UsageDashboardModelRowInput[] {
  return rows.map((row) => ({
    model: row.label || unknownModelLabel(),
    inputTokens: Math.max(row.inputTokens - row.cachedInputTokens, 0),
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cachedInputTokens,
    cacheWriteTokens: 0,
    ...(row.reasoningOutputTokens > 0 ? { reasoningTokens: row.reasoningOutputTokens } : {}),
    costUsd: row.estimatedCostUsd ?? null
  }))
}

function fromClaudeDaily(points: readonly ClaudeUsageDailyPoint[]): UsageDashboardDailyPoint[] {
  return points.map((point) => ({
    day: point.day,
    inputTokens: point.inputTokens,
    outputTokens: point.outputTokens,
    cacheReadTokens: point.cacheReadTokens,
    cacheWriteTokens: point.cacheWriteTokens,
    costUsd: 0
  }))
}

function fromClaudeModels(rows: readonly ClaudeUsageBreakdownRow[]): UsageDashboardModelRowInput[] {
  return rows.map((row) => ({
    model: row.label || unknownModelLabel(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.estimatedCostUsd
  }))
}

function fromOmpDaily(points: readonly OmpUsageDailyPoint[]): UsageDashboardDailyPoint[] {
  return points.map((point) => ({
    day: point.day,
    inputTokens: point.inputTokens,
    outputTokens: point.outputTokens,
    cacheReadTokens: point.cacheReadTokens,
    cacheWriteTokens: point.cacheWriteTokens,
    ...(point.reasoningTokens > 0 ? { reasoningTokens: point.reasoningTokens } : {}),
    costUsd: point.costUsd
  }))
}

function fromOmpModels(rows: readonly OmpUsageBreakdownRow[]): UsageDashboardModelRowInput[] {
  return rows.map((row) => ({
    model: row.label || unknownModelLabel(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    ...(row.reasoningTokens > 0 ? { reasoningTokens: row.reasoningTokens } : {}),
    costUsd: row.costUsd
  }))
}

async function isDashboardProviderEnabled(id: DashboardProviderId): Promise<boolean> {
  switch (id) {
    case 'claude':
      return (await window.api.claudeUsage.getScanState())?.enabled === true
    case 'codex':
      return (await window.api.codexUsage.getScanState())?.enabled === true
    case 'opencode':
      return (await window.api.openCodeUsage.getScanState())?.enabled === true
    case 'muse':
      return (await window.api.museUsage.getScanState())?.enabled === true
    case 'omp':
      return (await window.api.ompUsage.getScanState())?.enabled === true
  }
}

/**
 * Fetch one provider's daily points and model breakdown for the drawer, or null when the provider
 * is disabled (or its desktop-only API is unavailable). Failures stay local to the provider so one
 * broken provider cannot blank the whole drawer.
 */
export async function loadDashboardProviderData(
  id: DashboardProviderId,
  scope: DashboardScope,
  range: DashboardRange
): Promise<DashboardProviderData | null> {
  try {
    if (!(await isDashboardProviderEnabled(id))) {
      return null
    }
    switch (id) {
      case 'claude': {
        const [daily, models] = await Promise.all([
          window.api.claudeUsage.getDaily({ scope, range }),
          window.api.claudeUsage.getBreakdown({ scope, range, kind: 'model' })
        ])
        return { id, daily: fromClaudeDaily(daily), models: fromClaudeModels(models) }
      }
      case 'codex': {
        const [daily, models] = await Promise.all([
          window.api.codexUsage.getDaily({ scope, range }),
          window.api.codexUsage.getBreakdown({ scope, range, kind: 'model' })
        ])
        return { id, daily: fromCachedInputDaily(daily), models: fromCachedInputModels(models) }
      }
      case 'opencode': {
        const [daily, models] = await Promise.all([
          window.api.openCodeUsage.getDaily({ scope, range }),
          window.api.openCodeUsage.getBreakdown({ scope, range, kind: 'model' })
        ])
        return { id, daily: fromCachedInputDaily(daily), models: fromCachedInputModels(models) }
      }
      case 'muse': {
        const [daily, models] = await Promise.all([
          window.api.museUsage.getDaily({ scope, range }),
          window.api.museUsage.getBreakdown({ scope, range, kind: 'model' })
        ])
        return { id, daily: fromCachedInputDaily(daily), models: fromCachedInputModels(models) }
      }
      case 'omp': {
        // omp keeps a corpus-wide daily aggregate, so its scope argument is inert by design.
        const [daily, models] = await Promise.all([
          window.api.ompUsage.getDaily({ scope, range }),
          window.api.ompUsage.getBreakdown({ scope, range, kind: 'model' })
        ])
        return { id, daily: fromOmpDaily(daily), models: fromOmpModels(models) }
      }
    }
  } catch (error) {
    console.error(`Failed to load ${id} usage for the dashboard:`, error)
    return null
  }
}

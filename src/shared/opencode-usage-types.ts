import type { UsageHistoryRow } from './usage-history-types'

export type OpenCodeUsageScope = 'orca' | 'all'
export type OpenCodeUsageRange = '7d' | '30d' | '90d' | 'all'
export type OpenCodeUsageBreakdownKind = 'model' | 'project'

export type OpenCodeUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyOpenCodeData: boolean
}

export type OpenCodeUsageSummary = {
  scope: OpenCodeUsageScope
  range: OpenCodeUsageRange
  sessions: number
  events: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  topModel: string | null
  topProject: string | null
  hasAnyOpenCodeData: boolean
}

export type OpenCodeUsageDailyPoint = {
  day: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type OpenCodeUsageBreakdownRow = {
  key: string
  label: string
  sessions: number
  events: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
}

export type OpenCodeUsageSessionRow = {
  lastActiveDay?: string
  totalsScope?: 'lifetime' | 'selection'
  sessionId: string
  lastActiveAt: string
  durationMinutes: number | null
  projectLabel: string
  model: string | null
  events: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type OpenCodeUsageSnapshot = {
  scanState: OpenCodeUsageScanState
  summary: OpenCodeUsageSummary
  daily: OpenCodeUsageDailyPoint[]
  modelBreakdown: OpenCodeUsageBreakdownRow[]
  projectBreakdown: OpenCodeUsageBreakdownRow[]
  recentSessions: OpenCodeUsageSessionRow[]
  /** Calendar day on the recording host, using the same local boundary as history rows. */
  historyToday?: string
  history?: UsageHistoryRow[]
  historyNeedsRescan?: boolean
}

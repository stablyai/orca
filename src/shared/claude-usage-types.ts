export type ClaudeUsageScope = 'orca' | 'all'
export type ClaudeUsageRange = '7d' | '30d' | '90d' | 'all'
export type ClaudeUsageBreakdownKind = 'model' | 'project'

export type ClaudeUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyClaudeData: boolean
}

export type ClaudeUsageSummary = {
  scope: ClaudeUsageScope
  range: ClaudeUsageRange
  sessions: number
  turns: number
  zeroCacheReadTurns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheReuseRate: number | null
  estimatedCostUsd: number | null
  /** A row carried a model name that has no pricing entry, so its tokens are missing from `estimatedCostUsd`. */
  hasUnpricedModels: boolean
  topModel: string | null
  topProject: string | null
  hasAnyClaudeData: boolean
}

export type ClaudeUsageDailyPoint = {
  day: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type ClaudeUsageBreakdownRow = {
  key: string
  label: string
  sessions: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  estimatedCostUsd: number | null
}

export type ClaudeUsageSessionRow = {
  sessionId: string
  lastActiveAt: string
  durationMinutes: number
  projectLabel: string
  branch: string | null
  model: string | null
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type ClaudeUsageSnapshot = {
  scanState: ClaudeUsageScanState
  summary: ClaudeUsageSummary
  daily: ClaudeUsageDailyPoint[]
  modelBreakdown: ClaudeUsageBreakdownRow[]
  projectBreakdown: ClaudeUsageBreakdownRow[]
  recentSessions: ClaudeUsageSessionRow[]
}

export const CLAUDE_STATS_CACHE_UNAVAILABLE_REASONS = [
  'unsupported-version',
  'invalid',
  'too-large',
  'unreadable'
] as const

export type ClaudeStatsCacheUnavailableReason =
  (typeof CLAUDE_STATS_CACHE_UNAVAILABLE_REASONS)[number]

/** Claude's own /stats all-time total per transcript history; never merged into Orca totals. */
export type ClaudeStatsCacheHome = {
  configHome: string
  label: string
} & (
  | {
      status: 'ok'
      totalTokens: number
      lastComputedDate: string
    }
  | { status: 'unavailable'; reason: ClaudeStatsCacheUnavailableReason }
)

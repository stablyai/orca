export type ZcodeUsageScope = 'orca' | 'all'
export type ZcodeUsageRange = '7d' | '30d' | '90d' | 'all'
export type ZcodeUsageBreakdownKind = 'model' | 'project'

export type ZcodeUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyZcodeData: boolean
}

type ZcodeUsageTokenTotals = {
  inputTokens: number
  /** Subset of `inputTokens`; sum of cache reads and cache writes. */
  cachedInputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  /** Subset of `outputTokens`, as ZCode reports it. */
  reasoningOutputTokens: number
  totalTokens: number
}

export type ZcodeUsageSummary = ZcodeUsageTokenTotals & {
  scope: ZcodeUsageScope
  range: ZcodeUsageRange
  sessions: number
  events: number
  topModel: string | null
  topProject: string | null
  hasAnyZcodeData: boolean
}

export type ZcodeUsageDailyPoint = ZcodeUsageTokenTotals & { day: string }

export type ZcodeUsageBreakdownRow = ZcodeUsageTokenTotals & {
  key: string
  label: string
  sessions: number
  events: number
}

export type ZcodeUsageSessionRow = ZcodeUsageTokenTotals & {
  sessionId: string
  lastActiveAt: string
  durationMinutes: number
  projectLabel: string
  model: string | null
  events: number
}

export type ZcodeUsageSnapshot = {
  scanState: ZcodeUsageScanState
  summary: ZcodeUsageSummary
  daily: ZcodeUsageDailyPoint[]
  modelBreakdown: ZcodeUsageBreakdownRow[]
  projectBreakdown: ZcodeUsageBreakdownRow[]
  recentSessions: ZcodeUsageSessionRow[]
}

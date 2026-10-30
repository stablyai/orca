export type OmpUsageScope = 'orca' | 'all'
export type OmpUsageRange = '7d' | '30d' | '90d' | 'all'
export type OmpUsageBreakdownKind = 'model' | 'project'

export type OmpUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyOmpData: boolean
}

type OmpUsageTokenTotals = {
  /** Uncached input tokens; cache reads and writes are reported on their own lines. */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** Tracked for visibility only; never folded into outputTokens or totalTokens. */
  reasoningTokens: number
  totalTokens: number
  /** omp records precomputed per-message cost, so this is always a real sum. */
  costUsd: number
}

export type OmpUsageSummary = OmpUsageTokenTotals & {
  scope: OmpUsageScope
  range: OmpUsageRange
  sessions: number
  topModel: string | null
  topProject: string | null
  hasAnyOmpData: boolean
}

export type OmpUsageDailyPoint = OmpUsageTokenTotals & { day: string }

export type OmpUsageBreakdownRow = OmpUsageTokenTotals & {
  key: string
  label: string
  sessions: number
}

export type OmpUsageSessionRow = OmpUsageTokenTotals & {
  sessionId: string
  lastActiveAt: string
  durationMinutes: number
  projectLabel: string
  model: string | null
}

export type OmpUsageSnapshot = {
  scanState: OmpUsageScanState
  summary: OmpUsageSummary
  daily: OmpUsageDailyPoint[]
  modelBreakdown: OmpUsageBreakdownRow[]
  projectBreakdown: OmpUsageBreakdownRow[]
  recentSessions: OmpUsageSessionRow[]
}

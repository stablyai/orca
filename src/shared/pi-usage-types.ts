export type PiUsageScope = 'orca' | 'all'
export type PiUsageRange = '7d' | '30d' | '90d' | 'all'
export type PiUsageBreakdownKind = 'model' | 'project'

export type PiUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyPiData: boolean
}

type PiUsageTokenTotals = {
  inputTokens: number
  /** Pi cache reads, a subset of `inputTokens`. */
  cachedInputTokens: number
  outputTokens: number
  /** Subset of `outputTokens`, as Pi reports it. */
  reasoningOutputTokens: number
  totalTokens: number
}

export type PiUsageSummary = PiUsageTokenTotals & {
  scope: PiUsageScope
  range: PiUsageRange
  sessions: number
  events: number
  /** Sum of the cost Pi recorded per response; null when no response had a price. */
  estimatedCostUsd: number | null
  topModel: string | null
  topProject: string | null
  hasAnyPiData: boolean
}

export type PiUsageDailyPoint = PiUsageTokenTotals & { day: string }

export type PiUsageBreakdownRow = PiUsageTokenTotals & {
  key: string
  label: string
  sessions: number
  events: number
  estimatedCostUsd: number | null
}

export type PiUsageSessionRow = PiUsageTokenTotals & {
  sessionId: string
  lastActiveAt: string
  durationMinutes: number
  projectLabel: string
  model: string | null
  events: number
}

export type PiUsageSnapshot = {
  scanState: PiUsageScanState
  summary: PiUsageSummary
  daily: PiUsageDailyPoint[]
  modelBreakdown: PiUsageBreakdownRow[]
  projectBreakdown: PiUsageBreakdownRow[]
  recentSessions: PiUsageSessionRow[]
}

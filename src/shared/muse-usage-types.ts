export type MuseUsageScope = 'orca' | 'all'
export type MuseUsageRange = '7d' | '30d' | '90d' | 'all'
export type MuseUsageBreakdownKind = 'model' | 'project'

export type MuseUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyMuseData: boolean
}

type MuseUsageTokenTotals = {
  inputTokens: number
  /** Subset of `inputTokens`, as Muse reports it. */
  cachedInputTokens: number
  outputTokens: number
  /** Subset of `outputTokens`, as Muse reports it. */
  reasoningOutputTokens: number
  totalTokens: number
}

export type MuseUsageSummary = MuseUsageTokenTotals & {
  scope: MuseUsageScope
  range: MuseUsageRange
  sessions: number
  events: number
  topModel: string | null
  topProject: string | null
  hasAnyMuseData: boolean
}

export type MuseUsageDailyPoint = MuseUsageTokenTotals & { day: string }

export type MuseUsageBreakdownRow = MuseUsageTokenTotals & {
  key: string
  label: string
  sessions: number
  events: number
}

export type MuseUsageSessionRow = MuseUsageTokenTotals & {
  sessionId: string
  lastActiveAt: string
  durationMinutes: number
  projectLabel: string
  model: string | null
  events: number
}

export type MuseUsageSnapshot = {
  scanState: MuseUsageScanState
  summary: MuseUsageSummary
  daily: MuseUsageDailyPoint[]
  modelBreakdown: MuseUsageBreakdownRow[]
  projectBreakdown: MuseUsageBreakdownRow[]
  recentSessions: MuseUsageSessionRow[]
}

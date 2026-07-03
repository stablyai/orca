export type KimiUsageScope = 'orca' | 'all'
export type KimiUsageRange = '7d' | '30d' | '90d' | 'all'
export type KimiUsageBreakdownKind = 'model' | 'project'

export type KimiUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyKimiData: boolean
}

export type KimiUsageSummary = {
  scope: KimiUsageScope
  range: KimiUsageRange
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
  hasAnyKimiData: boolean
}

export type KimiUsageDailyPoint = {
  day: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type KimiUsageBreakdownRow = {
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

export type KimiUsageSessionRow = {
  sessionId: string
  lastActiveAt: string
  durationMinutes: number
  projectLabel: string
  model: string | null
  events: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type KimiUsageSnapshot = {
  scanState: KimiUsageScanState
  summary: KimiUsageSummary
  daily: KimiUsageDailyPoint[]
  modelBreakdown: KimiUsageBreakdownRow[]
  projectBreakdown: KimiUsageBreakdownRow[]
  recentSessions: KimiUsageSessionRow[]
}

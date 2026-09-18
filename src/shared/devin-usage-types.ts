export type DevinUsageScope = 'orca' | 'all'
export type DevinUsageRange = '7d' | '30d' | '90d' | 'all'
export type DevinUsageBreakdownKind = 'model' | 'project'

export type DevinUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyDevinData: boolean
}

export type DevinUsageSummary = {
  scope: DevinUsageScope
  range: DevinUsageRange
  sessions: number
  events: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  // Why: cachedInputTokens / inputTokens, with inputTokens inclusive of
  // cache-read. Defined here so the renderer does not infer token semantics.
  cacheShare: number
  topModel: string | null
  topProject: string | null
  hasAnyDevinData: boolean
}

export type DevinUsageDailyPoint = {
  day: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type DevinUsageBreakdownRow = {
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

export type DevinUsageSessionRow = {
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

export type DevinUsageSnapshot = {
  scanState: DevinUsageScanState
  summary: DevinUsageSummary
  daily: DevinUsageDailyPoint[]
  modelBreakdown: DevinUsageBreakdownRow[]
  projectBreakdown: DevinUsageBreakdownRow[]
  recentSessions: DevinUsageSessionRow[]
}

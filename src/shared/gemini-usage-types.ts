export type GeminiUsageScope = 'orca' | 'all'
export type GeminiUsageRange = '7d' | '30d' | '90d' | 'all'
export type GeminiUsageBreakdownKind = 'model' | 'project'

export type GeminiUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyGeminiData: boolean
}

export type GeminiUsageSummary = {
  scope: GeminiUsageScope
  range: GeminiUsageRange
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
  hasAnyGeminiData: boolean
}

export type GeminiUsageDailyPoint = {
  day: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type GeminiUsageBreakdownRow = {
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
  hasInferredPricing: boolean
}

export type GeminiUsageSessionRow = {
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
  hasInferredPricing: boolean
}

export type GeminiUsageSnapshot = {
  scanState: GeminiUsageScanState
  summary: GeminiUsageSummary
  daily: GeminiUsageDailyPoint[]
  modelBreakdown: GeminiUsageBreakdownRow[]
  projectBreakdown: GeminiUsageBreakdownRow[]
  recentSessions: GeminiUsageSessionRow[]
}

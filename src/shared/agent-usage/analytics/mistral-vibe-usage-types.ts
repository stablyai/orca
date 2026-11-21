export type MistralVibeUsageScope = 'orca' | 'all'
export type MistralVibeUsageRange = '7d' | '30d' | '90d' | 'all'
export type MistralVibeUsageBreakdownKind = 'model' | 'project'

export type MistralVibeUsageScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyMistralVibeData: boolean
}

type MistralVibeUsageTokenTotals = {
  inputTokens: number
  /** Subset of `inputTokens`, as Vibe reports it. */
  cachedInputTokens: number
  outputTokens: number
  /** Vibe's session catalog omits reasoning tokens, so this stays 0. */
  reasoningOutputTokens: number
  totalTokens: number
}

export type MistralVibeUsageSummary = MistralVibeUsageTokenTotals & {
  scope: MistralVibeUsageScope
  range: MistralVibeUsageRange
  sessions: number
  events: number
  estimatedCostUsd: number | null
  /** A session ran a model that Vibe's config.toml does not price, so its tokens are missing from `estimatedCostUsd`. */
  hasUnpricedModels: boolean
  topModel: string | null
  topProject: string | null
  hasAnyMistralVibeData: boolean
}

export type MistralVibeUsageDailyPoint = MistralVibeUsageTokenTotals & { day: string }

export type MistralVibeUsageBreakdownRow = MistralVibeUsageTokenTotals & {
  key: string
  label: string
  sessions: number
  events: number
  estimatedCostUsd: number | null
  hasUnpricedModels: boolean
}

export type MistralVibeUsageSessionRow = MistralVibeUsageTokenTotals & {
  sessionId: string
  lastActiveAt: string
  projectLabel: string
  model: string | null
  events: number
  estimatedCostUsd: number | null
}

export type MistralVibeUsageSnapshot = {
  scanState: MistralVibeUsageScanState
  summary: MistralVibeUsageSummary
  daily: MistralVibeUsageDailyPoint[]
  modelBreakdown: MistralVibeUsageBreakdownRow[]
  projectBreakdown: MistralVibeUsageBreakdownRow[]
  recentSessions: MistralVibeUsageSessionRow[]
}

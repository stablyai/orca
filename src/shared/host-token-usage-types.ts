export type HostTokenUsageProvider = 'claude' | 'codex'
export type HostTokenUsageRange = '7d' | '30d' | '90d' | 'all'
export type HostTokenUsageScope = 'orca' | 'all'

/** One provider's tokens on one host. Input excludes cache reads for every provider, so rows from different providers and hosts can be summed field by field. */
export type HostTokenUsageProviderRow = {
  provider: HostTokenUsageProvider
  /** False when usage tracking is off on this host; the token fields are then zero, not measured. */
  tracking: boolean
  lastScanCompletedAt: number | null
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  hasUnpricedModels: boolean
}

export type HostTokenUsageSummary = {
  range: HostTokenUsageRange
  scope: HostTokenUsageScope
  providers: HostTokenUsageProviderRow[]
}

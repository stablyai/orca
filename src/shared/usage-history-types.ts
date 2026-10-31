export type UsageHistoryProvider = 'claude' | 'codex' | 'opencode' | 'muse'
export type UsageHistoryRange = '7d' | '30d' | '90d' | 'all'

/** Disjoint token categories; cached input and reasoning are never added twice. */
export type UsageHistoryRow = {
  provider: UsageHistoryProvider
  /** Host-local roster ID; absent or null means ownership was not recorded. */
  accountId?: string | null
  day: string
  sessionId: string | null
  model: string | null
  projectKey: string
  projectLabel: string
  inOrca: boolean
  newInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  activityCount: number
  totalTokens: number
  apiEquivalentCostUsd: number | null
}

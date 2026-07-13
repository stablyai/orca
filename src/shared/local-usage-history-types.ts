export type LocalUsageHistoryProvider = 'gemini' | 'kimi'

export type LocalUsageHistoryScanState = {
  enabled: boolean
  isScanning: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
  hasAnyData: boolean
}

export type LocalUsageHistoryHourlyPoint = {
  day: string
  hour: number
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  cacheWriteTokens: number
  toolTokens: number
  totalTokens: number
}

export type LocalUsageHistoryHourlyQuery = { days: number } | { startDay: string; endDay: string }

export type LocalUsageHistoryHourlyResult = {
  scanState: LocalUsageHistoryScanState
  points: LocalUsageHistoryHourlyPoint[]
}

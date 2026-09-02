import type {
  ClaudeUsageDailyPoint,
  ClaudeUsageScanState,
  ClaudeUsageSummary
} from '../../../../shared/claude-usage-types'
import type {
  CodexUsageDailyPoint,
  CodexUsageScanState,
  CodexUsageSummary
} from '../../../../shared/codex-usage-types'
import type {
  OpenCodeUsageDailyPoint,
  OpenCodeUsageScanState,
  OpenCodeUsageSummary
} from '../../../../shared/opencode-usage-types'

export type UsageProviderId = 'claude' | 'codex' | 'opencode'

export type UsageProviderOverview = {
  id: UsageProviderId
  label: string
  enabled: boolean
  isScanning: boolean
  hasData: boolean
  lastScanCompletedAt: number | null
  lastScanError: string | null
  sessions: number
  activityLabel: 'turns' | 'events'
  activityCount: number
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  reasoningTokens: number
  estimatedCostUsd: number | null
  topModel: string | null
  topProject: string | null
  activeDays: number
}

export type UsageOverviewDailyPoint = {
  day: string
  totalTokens: number
  claudeTokens: number
  codexTokens: number
  openCodeTokens: number
  intensity: 0 | 1 | 2 | 3 | 4
}

export type UsageOverviewModel = {
  providers: UsageProviderOverview[]
  enabledProviderCount: number
  dataProviderCount: number
  hasAnyEnabledProvider: boolean
  hasAnyData: boolean
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  reasoningTokens: number
  sessions: number
  activityCount: number
  activeDays: number
  estimatedCostUsd: number | null
  hasPartialCost: boolean
  cacheShare: number | null
  daily: UsageOverviewDailyPoint[]
  bestDay: UsageOverviewDailyPoint | null
  lastUpdatedAt: number | null
}

export type UsageOverviewInput = {
  claude: {
    scanState: ClaudeUsageScanState | null
    summary: ClaudeUsageSummary | null
    daily: ClaudeUsageDailyPoint[]
  }
  codex: {
    scanState: CodexUsageScanState | null
    summary: CodexUsageSummary | null
    daily: CodexUsageDailyPoint[]
  }
  opencode: {
    scanState: OpenCodeUsageScanState | null
    summary: OpenCodeUsageSummary | null
    daily: OpenCodeUsageDailyPoint[]
  }
}

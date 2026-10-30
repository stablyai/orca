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
import type {
  MuseUsageDailyPoint,
  MuseUsageScanState,
  MuseUsageSummary
} from '../../../../shared/muse-usage-types'
import type {
  OmpUsageDailyPoint,
  OmpUsageScanState,
  OmpUsageSummary
} from '../../../../shared/omp-usage-types'

export type UsageProviderId = 'claude' | 'codex' | 'opencode' | 'muse' | 'omp'

export type UsageProviderOverview = {
  id: UsageProviderId
  label: string
  enabled: boolean
  isScanning: boolean
  hasData: boolean
  lastScanCompletedAt: number | null
  lastScanError: string | null
  sessions: number
  /** omp records sessions only, so its overview row reports no separate turns/events count. */
  activityLabel: 'turns' | 'events' | 'sessions'
  activityCount: number
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  reasoningTokens: number
  estimatedCostUsd: number | null
  /** The provider priced some of its tokens but not all, so `estimatedCostUsd` understates the bill. */
  hasPartialCost: boolean
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
  museTokens: number
  ompTokens: number
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
  muse: {
    scanState: MuseUsageScanState | null
    summary: MuseUsageSummary | null
    daily: MuseUsageDailyPoint[]
  }
  /**
   * omp daily totals, merged into the combined series when supplied. The overview provider rows
   * (`buildUsageOverview`) stay on the four turn/event providers until omp gains its own sessions row.
   */
  omp?: {
    scanState: OmpUsageScanState | null
    summary: OmpUsageSummary | null
    daily: OmpUsageDailyPoint[]
  }
}

import type { ClaudeUsageSnapshot } from './agent-usage/analytics/claude-usage-types'
import type { CodexUsageSnapshot } from './agent-usage/analytics/codex-usage-types'
import type { MuseUsageSnapshot } from './agent-usage/analytics/muse-usage-types'
import type { OpenCodeUsageSnapshot } from './agent-usage/analytics/opencode-usage-types'
import type { UsageHistoryRange } from './usage-history-types'

export const USAGE_HISTORY_RUNTIME_CAPABILITY = 'usage.history.v1' as const
export const USAGE_RUNTIME_CAPABILITIES = [USAGE_HISTORY_RUNTIME_CAPABILITY] as const

export type UsageSnapshotByProvider = {
  claude: ClaudeUsageSnapshot
  codex: CodexUsageSnapshot
  opencode: OpenCodeUsageSnapshot
  muse: MuseUsageSnapshot
}

export type UsageHistorySnapshot = UsageSnapshotByProvider[keyof UsageSnapshotByProvider]

export type UsageSnapshotQuery = {
  scope: 'orca' | 'all'
  range: UsageHistoryRange
  limit?: number
  includeHistory?: boolean
}

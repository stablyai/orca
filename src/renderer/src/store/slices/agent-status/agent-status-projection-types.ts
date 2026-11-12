import type { DashboardBucket } from '../../../../../shared/dashboard-snapshot'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { WorktreeAgentActivitySummary } from '@/components/sidebar/workspace-card/activity/worktree-agent-activity-summary'
import type { WorktreeAttention } from '../../../../../shared/sidebar-list/smart-attention'
import { KeyedDeadlines } from '../../../../../shared/keyed-deadlines'
import type { TabAgentPane } from '@/lib/agent-session/tab-identity/tab-agent-status-index'

export const EMPTY_KEYS: readonly string[] = Object.freeze([])

export const EMPTY_ICONS: readonly TabAgentPane[] = Object.freeze([])

export const FLAGS = [
  'hasPermission',
  'hasLiveWorking',
  'hasLiveMonitoring',
  'hasFailed',
  'hasInterrupted',
  'hasUnconfirmed',
  'hasLiveDone'
] as const

export const emptySummary = (): WorktreeAgentActivitySummary => ({
  hasPermission: false,
  hasLiveWorking: false,
  hasLiveMonitoring: false,
  hasFailed: false,
  hasInterrupted: false,
  hasUnconfirmed: false,
  hasLiveDone: false,
  agentStatusPaneIdsByTabId: {},
  stalePaneIdsByTabId: {}
})

export const EMPTY_SUMMARY = emptySummary()

export type Contribution = {
  worktreeId: string
  flags: readonly string[]
  panes: readonly string[]
  stale: readonly string[]
  attention: WorktreeAttention
  fresh?: boolean
  titleState?: string
}

export type DashboardCounts = Readonly<Record<DashboardBucket, number>>

export const EMPTY_COUNTS: DashboardCounts = Object.freeze({
  attention: 0,
  working: 0,
  done: 0,
  idle: 0
})

export type CountedRow = { owner: string; bucket: DashboardBucket }

export type Candidate = { rank: number; updatedAt: number; dead: boolean }

export type Bucket = {
  keys: Set<string>
  arrangement: readonly string[]
  revision: number
  counts: Map<string, number>
  summary: WorktreeAgentActivitySummary
  attention: KeyedDeadlines[]
}

export function bucket(): Bucket {
  return {
    keys: new Set(),
    arrangement: EMPTY_KEYS,
    revision: 0,
    counts: new Map(),
    summary: emptySummary(),
    attention: Array.from({ length: 4 }, () => new KeyedDeadlines())
  }
}

export type PreparedRow = {
  rows: DashboardAgentRow[]
  worktreeId?: string
  contribution?: Contribution
  tabId?: string
  candidate?: Omit<Candidate, 'rank'>
}

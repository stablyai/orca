import type { AgentDotState } from '@/components/AgentStateDot'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ActivityPortalReadinessStatus } from './activity-portal-readiness-oscillation'

export type ThreadReadFilter = 'all' | 'unread'
export type ActivityGroupBy = 'none' | 'status' | 'project' | 'worktree' | 'agent'
export type ActivityEventState = Extract<AgentStatusState, 'done' | 'blocked' | 'waiting'>
export type ActivityHookLiveAgentState = Extract<
  AgentStatusState,
  'working' | 'blocked' | 'waiting'
>
export type ActivityLiveAgentState = ActivityHookLiveAgentState | 'monitoring'
export type ActivityStatusGroupId =
  | 'working'
  | 'monitoring'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'interrupted'

export type ActivityEvent = {
  id: string
  state: ActivityEventState
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  migrationUnsupportedPtyId?: string
  unread: boolean
}

export type ActivityLiveAgentSnapshot = {
  state: ActivityLiveAgentState
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
}

// Why: keyed per agent pane (tab + leaf id), not per workspace, so the list shows one row per agent; paneKey is `${tabId}:${leafId}`.
export type AgentPaneThread = {
  paneKey: string
  paneTitle: string
  worktree: Worktree
  repo: Repo | null
  tab: TerminalTab
  agentType: AgentType
  currentAgentState: ActivityLiveAgentState | null
  currentAgentEntry: AgentStatusEntry | null
  responsePreview: string
  latestTimestamp: number
  latestEvent: ActivityEvent | null
  events: ActivityEvent[]
  migrationUnsupportedPtyId?: string
  unread: boolean
}

export type ActivityThreadGroup = {
  key: string
  id?: ActivityStatusGroupId
  label: string
  state?: AgentDotState
  threads: AgentPaneThread[]
}

export type ActivityTerminalPortalReadiness = {
  target: HTMLElement | null
  paneKey: string | null
  status: ActivityPortalReadinessStatus
}

export type ActivityTerminalPortalDomStatus = {
  ready: boolean
  unavailable: boolean
}

export type ActivityTerminalPortalSlotId = 'primary' | 'secondary'

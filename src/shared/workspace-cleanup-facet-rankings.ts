import type {
  WorkspaceCleanupAgentState,
  WorkspaceCleanupBlockerMode,
  WorkspaceCleanupGitState,
  WorkspaceCleanupIdleSignal,
  WorkspaceCleanupPresence,
  WorkspaceCleanupReviewState,
  WorkspaceCleanupSortDirectionState,
  WorkspaceCleanupSortField,
  WorkspaceCleanupTicketSource,
  WorkspaceCleanupTriState
} from './workspace-cleanup-filter-model'
import type { WorkspaceCleanupBlocker, WorkspaceCleanupTier } from './workspace-cleanup'

// Records (not bare arrays) so tsc fails when a union gains a member.
const BLOCKER_SEVERITY: Record<WorkspaceCleanupBlocker, number> = {
  'main-worktree': 100,
  'folder-repo': 95,
  'active-workspace': 90,
  pinned: 85,
  'live-agent': 80,
  'running-terminal': 75,
  'dirty-editor-buffer': 70,
  'volatile-local-context': 65,
  'recent-visible-context': 60,
  'terminal-liveness-unknown': 55,
  'ssh-disconnected': 50,
  'unpushed-commits': 45,
  'dirty-files': 40,
  'unknown-base': 35,
  'git-status-error': 30,
  dismissed: 10
}

const TIER_RANK: Record<WorkspaceCleanupTier, number> = { ready: 0, review: 1, protected: 2 }

const AGENT_RANK: Record<WorkspaceCleanupAgentState, number> = {
  idle: 0,
  working: 2,
  permission: 3
}

const GIT_RANK: Record<WorkspaceCleanupGitState, number> = {
  clean: 1,
  unknown: 2,
  dirty: 3,
  unpushed: 4
}

const REVIEW_RANK: Record<WorkspaceCleanupReviewState, number> = {
  merged: 1,
  closed: 1,
  unknown: 2,
  draft: 3,
  open: 3
}

export const WORKSPACE_CLEANUP_BLOCKER_VALUES = Object.keys(
  BLOCKER_SEVERITY
) as WorkspaceCleanupBlocker[]
export const WORKSPACE_CLEANUP_TIER_VALUES = Object.keys(TIER_RANK) as WorkspaceCleanupTier[]
export const WORKSPACE_CLEANUP_AGENT_STATE_VALUES = Object.keys(
  AGENT_RANK
) as WorkspaceCleanupAgentState[]
export const WORKSPACE_CLEANUP_GIT_STATE_VALUES = Object.keys(
  GIT_RANK
) as WorkspaceCleanupGitState[]
export const WORKSPACE_CLEANUP_REVIEW_STATE_VALUES = Object.keys(
  REVIEW_RANK
) as WorkspaceCleanupReviewState[]
export const WORKSPACE_CLEANUP_TICKET_SOURCE_VALUES: WorkspaceCleanupTicketSource[] = [
  'work-item',
  'linear',
  'issue'
]
export const WORKSPACE_CLEANUP_IDLE_SIGNAL_VALUES: WorkspaceCleanupIdleSignal[] = [
  'last-visited',
  'last-activity',
  'created'
]
export const WORKSPACE_CLEANUP_TRI_STATE_VALUES: WorkspaceCleanupTriState[] = [
  'any',
  'only',
  'exclude'
]
export const WORKSPACE_CLEANUP_PRESENCE_VALUES: WorkspaceCleanupPresence[] = ['any', 'some', 'none']
export const WORKSPACE_CLEANUP_BLOCKER_MODE_VALUES: WorkspaceCleanupBlockerMode[] = [
  'any-of',
  'none-of'
]
export const WORKSPACE_CLEANUP_SORT_DIRECTION_VALUES: WorkspaceCleanupSortDirectionState[] = [
  'asc',
  'desc'
]
export const WORKSPACE_CLEANUP_SORT_FIELD_VALUES: WorkspaceCleanupSortField[] = [
  'last-activity',
  'last-visited',
  'created',
  'size',
  'name',
  'repo',
  'path',
  'host',
  'workspace-status',
  'agent',
  'git',
  'ahead',
  'behind',
  'branch',
  'review',
  'ticket',
  'local-context',
  'tier',
  'blocker-count'
]

export function getWorkspaceCleanupBlockerSeverity(blocker: WorkspaceCleanupBlocker): number {
  return BLOCKER_SEVERITY[blocker] ?? 0
}

export function getWorkspaceCleanupTierRank(tier: WorkspaceCleanupTier): number {
  return TIER_RANK[tier] ?? 0
}

export function getWorkspaceCleanupAgentRank(state: WorkspaceCleanupAgentState): number {
  return AGENT_RANK[state] ?? 0
}

export function getWorkspaceCleanupGitRank(state: WorkspaceCleanupGitState): number {
  return GIT_RANK[state] ?? 0
}

export function getWorkspaceCleanupReviewRank(state: WorkspaceCleanupReviewState | null): number {
  return state === null ? 0 : (REVIEW_RANK[state] ?? 0)
}

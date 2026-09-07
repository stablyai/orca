import type { LiveAgentWorktreeStatus } from '@/lib/worktree-activity-state'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'
import {
  canQueueWorkspaceCleanupCandidate,
  WORKSPACE_CLEANUP_BULK_SELECT_EXCLUSIONS,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupGitState } from './workspace-cleanup-filter-sort'
import type {
  WorkspaceCleanupAgentState,
  WorkspaceCleanupGitState,
  WorkspaceCleanupReviewState,
  WorkspaceCleanupTicketSource
} from '../../../../shared/workspace-cleanup-filter-model'
import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'
import {
  getWorkspaceCleanupCandidateHostId,
  getWorkspaceCleanupHostIdentity,
  type WorkspaceCleanupWorktreeFacts
} from './workspace-cleanup-host-identity'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'
export type { WorkspaceCleanupWorktreeFacts } from './workspace-cleanup-host-identity'

export type WorkspaceCleanupFacetSources = {
  worktreeById?: ReadonlyMap<string, WorkspaceCleanupWorktreeFacts>
  workspaceStatuses?: readonly WorkspaceStatusDefinition[]
  /** Absent entry = the space scan never ran for that worktree. */
  sizeBytesByWorktreeId?: ReadonlyMap<string, number>
  lastVisitedAtByWorktreeId?: Readonly<Record<string, number>>
  liveAgentStatusByWorktreeId?: ReadonlyMap<string, LiveAgentWorktreeStatus>
  reviewInfoByWorktreeId?: ReadonlyMap<string, WorkspaceCleanupReviewInfo>
  /** Host-qualified identities, matching how dismissals are stored (STA-4343). */
  dismissedIdentities?: ReadonlySet<string>
}

export type WorkspaceCleanupFacets = {
  candidate: WorkspaceCleanupCandidate
  worktreeId: string
  /** Host-qualified row key; `worktreeId` alone repeats across hosts (STA-4343). */
  identity: string
  repoId: string
  repoName: string
  displayName: string
  path: string
  branch: string
  hostId: ExecutionHostId
  blockers: readonly WorkspaceCleanupBlocker[]
  blockerCount: number
  isDismissed: boolean
  isSelectable: boolean
  /** Background signal: ambient PTY/agent churn bumps this without a human. */
  lastActivityAt: number
  createdAt: number | null
  /** Honest "user opened it" signal; null when Orca never recorded a visit. */
  lastVisitedAt: number | null
  sizeBytes: number | null
  workspaceStatus: string | null
  workspaceStatusLabel: string | null
  isArchived: boolean
  isPinned: boolean
  isUnread: boolean
  hasComment: boolean
  agentState: WorkspaceCleanupAgentState
  retainedDoneAgentCount: number
  gitState: WorkspaceCleanupGitState
  upstreamAhead: number | null
  upstreamBehind: number | null
  isPrunable: boolean
  isLocked: boolean
  review: WorkspaceCleanupReviewInfo
  reviewState: WorkspaceCleanupReviewState | null
  ticketSources: readonly WorkspaceCleanupTicketSource[]
  localContextCount: number
  hasLocalContext: boolean
  isCompletelyEmpty: boolean
  searchText: string
}

const EMPTY_REVIEW_INFO: WorkspaceCleanupReviewInfo = {
  hasReview: false,
  label: null,
  state: null,
  provider: null,
  title: null
}

export function buildWorkspaceCleanupFacets(
  candidate: WorkspaceCleanupCandidate,
  sources: WorkspaceCleanupFacetSources = {}
): WorkspaceCleanupFacets {
  const hostIdentity = getWorkspaceCleanupHostIdentity(
    getWorkspaceCleanupCandidateHostId(candidate),
    candidate.worktreeId
  )
  const worktree =
    sources.worktreeById?.get(hostIdentity) ??
    sources.worktreeById?.get(candidate.worktreeId) ??
    null
  const review =
    sources.reviewInfoByWorktreeId?.get(hostIdentity) ??
    sources.reviewInfoByWorktreeId?.get(candidate.worktreeId) ??
    EMPTY_REVIEW_INFO
  const ticketSources = getTicketSources(worktree)
  const localContextCount = getLocalContextCount(candidate)
  const hasComment = (worktree?.comment ?? '').trim().length > 0
  const branch = getBranchDisplayName(worktree?.branch ?? candidate.branch)
  const facets: Omit<WorkspaceCleanupFacets, 'searchText'> = {
    candidate,
    worktreeId: candidate.worktreeId,
    identity: hostIdentity,
    repoId: candidate.repoId,
    repoName: candidate.repoName,
    displayName: candidate.displayName,
    path: candidate.path,
    branch,
    hostId: worktree?.hostId ?? getWorkspaceCleanupCandidateHostId(candidate),
    blockers: candidate.blockers,
    blockerCount: candidate.blockers.length,
    isDismissed:
      (sources.dismissedIdentities?.has(getWorkspaceCleanupCandidateIdentity(candidate)) ??
        false) ||
      candidate.blockers.includes('dismissed'),
    isSelectable:
      canQueueWorkspaceCleanupCandidate(candidate) &&
      !candidate.blockers.some((blocker) => WORKSPACE_CLEANUP_BULK_SELECT_EXCLUSIONS.has(blocker)),
    lastActivityAt: candidate.lastActivityAt,
    createdAt: toFiniteOrNull(worktree?.createdAt ?? candidate.createdAt),
    lastVisitedAt: toFiniteOrNull(
      getWorktreeVisitTimestamp(sources.lastVisitedAtByWorktreeId, {
        id: candidate.worktreeId,
        hostId: worktree?.hostId ?? getWorkspaceCleanupCandidateHostId(candidate)
      })
    ),
    sizeBytes: toFiniteOrNull(
      sources.sizeBytesByWorktreeId?.get(hostIdentity) ??
        sources.sizeBytesByWorktreeId?.get(candidate.worktreeId)
    ),
    workspaceStatus: normalizeStatus(worktree?.workspaceStatus),
    workspaceStatusLabel: getWorkspaceStatusLabel(worktree, sources.workspaceStatuses),
    isArchived: worktree?.isArchived ?? candidate.reasons.includes('archived'),
    isPinned: worktree?.isPinned ?? candidate.blockers.includes('pinned'),
    isUnread: worktree?.isUnread ?? false,
    hasComment,
    agentState: toWorkspaceCleanupAgentState(
      sources.liveAgentStatusByWorktreeId?.get(candidate.worktreeId)
    ),
    retainedDoneAgentCount: candidate.localContext.retainedDoneAgentCount,
    gitState: getWorkspaceCleanupGitState(candidate),
    upstreamAhead: toFiniteOrNull(candidate.git.upstreamAhead),
    upstreamBehind: toFiniteOrNull(candidate.git.upstreamBehind),
    isPrunable: worktree?.prunable ?? false,
    isLocked: worktree?.locked ?? false,
    review,
    reviewState: review.hasReview ? (review.state ?? 'unknown') : null,
    ticketSources,
    localContextCount,
    hasLocalContext: localContextCount > 0,
    isCompletelyEmpty:
      localContextCount === 0 && !review.hasReview && ticketSources.length === 0 && !hasComment
  }
  return { ...facets, searchText: buildSearchText(facets) }
}

export function buildWorkspaceCleanupFacetList(
  candidates: readonly WorkspaceCleanupCandidate[],
  sources: WorkspaceCleanupFacetSources = {}
): WorkspaceCleanupFacets[] {
  return candidates.map((candidate) => buildWorkspaceCleanupFacets(candidate, sources))
}

export function countWorkspaceCleanupMeasuredRows(rows: readonly WorkspaceCleanupFacets[]): number {
  return rows.reduce((count, row) => count + (row.sizeBytes === null ? 0 : 1), 0)
}

// Why: monitoring is still registered background work, so it filters as active — offering
// such a workspace as idle would invite cleaning up a running dev server (#10997).
function toWorkspaceCleanupAgentState(
  status: LiveAgentWorktreeStatus | undefined
): WorkspaceCleanupAgentState {
  if (status === undefined) {
    return 'idle'
  }
  return status === 'monitoring' ? 'working' : status
}

function getLocalContextCount(candidate: WorkspaceCleanupCandidate): number {
  const context = candidate.localContext
  return (
    context.terminalTabCount +
    context.cleanEditorTabCount +
    context.browserTabCount +
    context.diffCommentCount +
    context.retainedDoneAgentCount
  )
}

function getTicketSources(
  worktree: WorkspaceCleanupWorktreeFacts | null
): WorkspaceCleanupTicketSource[] {
  if (!worktree) {
    return []
  }
  const sources: WorkspaceCleanupTicketSource[] = []
  if (worktree.linkedWorkItem != null) {
    sources.push('work-item')
  }
  if ((worktree.linkedLinearIssue ?? '').length > 0) {
    sources.push('linear')
  }
  if (worktree.linkedIssue != null) {
    sources.push('issue')
  }
  return sources
}

function buildSearchText(facets: Omit<WorkspaceCleanupFacets, 'searchText'>): string {
  return [
    facets.displayName,
    facets.repoName,
    facets.branch,
    facets.path,
    facets.hostId,
    facets.workspaceStatus,
    facets.workspaceStatusLabel,
    facets.review.label,
    facets.review.title,
    facets.review.provider,
    facets.gitState,
    ...facets.ticketSources,
    ...facets.blockers
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()
}

function normalizeStatus(status: string | undefined): string | null {
  const trimmed = (status ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function getWorkspaceStatusLabel(
  worktree: WorkspaceCleanupWorktreeFacts | null,
  statuses: readonly WorkspaceStatusDefinition[] | undefined
): string | null {
  if (!worktree || !statuses?.length) {
    return null
  }
  const statusId = getWorkspaceStatus({ workspaceStatus: worktree.workspaceStatus }, statuses)
  return statuses.find((status) => status.id === statusId)?.label ?? statusId
}

function toFiniteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getBranchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '') || 'HEAD'
}

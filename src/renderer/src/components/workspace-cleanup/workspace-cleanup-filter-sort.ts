import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupContextFilter,
  WorkspaceCleanupFilters,
  WorkspaceCleanupGitFilter,
  WorkspaceCleanupReviewFilter,
  WorkspaceCleanupReviewInfo,
  WorkspaceCleanupSortDirection,
  WorkspaceCleanupSortKey,
  WorkspaceCleanupTimeFilter
} from './workspace-cleanup-presentation'

const DAY_MS = 24 * 60 * 60 * 1000

const EMPTY_REVIEW_INFO: WorkspaceCleanupReviewInfo = {
  hasReview: false,
  label: null,
  state: null,
  provider: null,
  title: null
}

const EMPTY_REVIEW_INFO_MAP = new Map<string, WorkspaceCleanupReviewInfo>()

export function hasWorkspaceCleanupLocalContext(candidate: WorkspaceCleanupCandidate): boolean {
  return (
    candidate.localContext.terminalTabCount > 0 ||
    candidate.localContext.cleanEditorTabCount > 0 ||
    candidate.localContext.browserTabCount > 0 ||
    candidate.localContext.diffCommentCount > 0 ||
    candidate.localContext.retainedDoneAgentCount > 0
  )
}

export function getWorkspaceCleanupSearchText(
  candidate: WorkspaceCleanupCandidate,
  reviewInfo: WorkspaceCleanupReviewInfo = EMPTY_REVIEW_INFO
): string {
  return [
    candidate.displayName,
    candidate.repoName,
    candidate.branch,
    candidate.path,
    reviewInfo.label,
    reviewInfo.title,
    getWorkspaceCleanupGitLabel(candidate),
    hasWorkspaceCleanupLocalContext(candidate) ? 'has context' : 'no context'
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function filterWorkspaceCleanupCandidates(
  candidates: readonly WorkspaceCleanupCandidate[],
  filters: WorkspaceCleanupFilters,
  reviewInfoByWorktreeId: ReadonlyMap<string, WorkspaceCleanupReviewInfo> = EMPTY_REVIEW_INFO_MAP,
  now: number = Date.now()
): WorkspaceCleanupCandidate[] {
  const normalizedQuery = filters.query.trim().toLowerCase()
  return candidates.filter((candidate) => {
    const reviewInfo = reviewInfoByWorktreeId.get(candidate.worktreeId) ?? EMPTY_REVIEW_INFO
    if (
      normalizedQuery &&
      !getWorkspaceCleanupSearchText(candidate, reviewInfo).includes(normalizedQuery)
    ) {
      return false
    }
    return (
      matchesTimeFilter(candidate, filters.time, now) &&
      matchesReviewFilter(reviewInfo, filters.review) &&
      matchesGitFilter(candidate, filters.git) &&
      matchesContextFilter(candidate, filters.context)
    )
  })
}

export function sortWorkspaceCleanupCandidates(
  candidates: readonly WorkspaceCleanupCandidate[],
  sortKey: WorkspaceCleanupSortKey,
  direction: WorkspaceCleanupSortDirection,
  reviewInfoByWorktreeId: ReadonlyMap<string, WorkspaceCleanupReviewInfo> = EMPTY_REVIEW_INFO_MAP
): WorkspaceCleanupCandidate[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...candidates].sort((left, right) => {
    const primary =
      compareWorkspaceCleanupCandidates(left, right, sortKey, reviewInfoByWorktreeId) * multiplier
    return (
      primary ||
      left.lastActivityAt - right.lastActivityAt ||
      left.repoName.localeCompare(right.repoName) ||
      left.displayName.localeCompare(right.displayName)
    )
  })
}

export function getWorkspaceCleanupGitLabel(candidate: WorkspaceCleanupCandidate): string {
  if (hasUnpushedCommits(candidate)) {
    return 'Unpushed'
  }
  if (isGitStatusUnknown(candidate)) {
    return 'Unknown'
  }
  if (candidate.git.clean === true) {
    return 'Clean'
  }
  if (candidate.git.clean === false) {
    return 'Dirty'
  }
  return 'Unknown'
}

function compareWorkspaceCleanupCandidates(
  left: WorkspaceCleanupCandidate,
  right: WorkspaceCleanupCandidate,
  sortKey: WorkspaceCleanupSortKey,
  reviewInfoByWorktreeId: ReadonlyMap<string, WorkspaceCleanupReviewInfo>
): number {
  switch (sortKey) {
    case 'activity':
      return left.lastActivityAt - right.lastActivityAt
    case 'name':
      return left.displayName.localeCompare(right.displayName)
    case 'repo':
      return (
        left.repoName.localeCompare(right.repoName) ||
        left.displayName.localeCompare(right.displayName)
      )
    case 'review':
      return (
        getReviewSortRank(reviewInfoByWorktreeId.get(left.worktreeId) ?? EMPTY_REVIEW_INFO) -
          getReviewSortRank(reviewInfoByWorktreeId.get(right.worktreeId) ?? EMPTY_REVIEW_INFO) ||
        (reviewInfoByWorktreeId.get(left.worktreeId)?.label ?? '').localeCompare(
          reviewInfoByWorktreeId.get(right.worktreeId)?.label ?? ''
        )
      )
    case 'git':
      return getGitSortRank(left) - getGitSortRank(right)
  }
}

function matchesTimeFilter(
  candidate: WorkspaceCleanupCandidate,
  filter: WorkspaceCleanupTimeFilter,
  now: number
): boolean {
  switch (filter) {
    case 'all':
      return true
    case '30d':
      return now - candidate.lastActivityAt >= 30 * DAY_MS
    case '90d':
      return now - candidate.lastActivityAt >= 90 * DAY_MS
    case 'archived':
      return candidate.reasons.includes('archived')
  }
}

function matchesReviewFilter(
  reviewInfo: WorkspaceCleanupReviewInfo,
  filter: WorkspaceCleanupReviewFilter
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'no-review':
      return !reviewInfo.hasReview
    case 'has-review':
      return reviewInfo.hasReview
    case 'open-review':
      return reviewInfo.hasReview && (reviewInfo.state === 'open' || reviewInfo.state === 'draft')
    case 'closed-review':
      return (
        reviewInfo.hasReview && (reviewInfo.state === 'closed' || reviewInfo.state === 'merged')
      )
  }
}

function matchesGitFilter(
  candidate: WorkspaceCleanupCandidate,
  filter: WorkspaceCleanupGitFilter
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'clean':
      return (
        candidate.git.clean === true &&
        !hasUnpushedCommits(candidate) &&
        !isGitStatusUnknown(candidate)
      )
    case 'dirty':
      return candidate.git.clean === false
    case 'unpushed':
      return hasUnpushedCommits(candidate)
    case 'unknown':
      return isGitStatusUnknown(candidate)
  }
}

function matchesContextFilter(
  candidate: WorkspaceCleanupCandidate,
  filter: WorkspaceCleanupContextFilter
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'has-context':
      return hasWorkspaceCleanupLocalContext(candidate)
    case 'no-context':
      return !hasWorkspaceCleanupLocalContext(candidate)
  }
}

function getReviewSortRank(reviewInfo: WorkspaceCleanupReviewInfo): number {
  if (!reviewInfo.hasReview) {
    return 0
  }
  if (reviewInfo.state === 'open' || reviewInfo.state === 'draft') {
    return 3
  }
  if (reviewInfo.state === 'unknown') {
    return 2
  }
  return 1
}

function getGitSortRank(candidate: WorkspaceCleanupCandidate): number {
  if (hasUnpushedCommits(candidate)) {
    return 4
  }
  if (candidate.git.clean === false) {
    return 3
  }
  if (isGitStatusUnknown(candidate)) {
    return 2
  }
  return 1
}

function hasUnpushedCommits(candidate: WorkspaceCleanupCandidate): boolean {
  return (candidate.git.upstreamAhead ?? 0) > 0 || candidate.blockers.includes('unpushed-commits')
}

function isGitStatusUnknown(candidate: WorkspaceCleanupCandidate): boolean {
  return (
    candidate.git.clean === null ||
    candidate.blockers.includes('git-status-error') ||
    candidate.blockers.includes('unknown-base')
  )
}

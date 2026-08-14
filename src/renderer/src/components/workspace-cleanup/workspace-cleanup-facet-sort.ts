import type { WorkspaceCleanupFacets } from './workspace-cleanup-facets'
import {
  getWorkspaceCleanupAgentRank,
  getWorkspaceCleanupBlockerSeverity,
  getWorkspaceCleanupGitRank,
  getWorkspaceCleanupReviewRank,
  getWorkspaceCleanupTierRank
} from '../../../../shared/workspace-cleanup-facet-rankings'
import type {
  WorkspaceCleanupSortDirectionState,
  WorkspaceCleanupSortField,
  WorkspaceCleanupSortState
} from '../../../../shared/workspace-cleanup-filter-model'

/**
 * Fields whose value can be absent. Absent rows always sink to the bottom in
 * BOTH directions — flipping direction should reorder the rows that carry the
 * signal, not promote the ones that carry nothing.
 */
const ABSENT_LAST_FIELDS: ReadonlySet<WorkspaceCleanupSortField> = new Set([
  'size',
  'last-visited',
  'created',
  'ahead',
  'behind',
  'workspace-status',
  'review',
  'ticket'
])

export function isWorkspaceCleanupAbsentLastSortField(field: WorkspaceCleanupSortField): boolean {
  return ABSENT_LAST_FIELDS.has(field)
}

export function sortWorkspaceCleanupFacets(
  facets: readonly WorkspaceCleanupFacets[],
  sort: WorkspaceCleanupSortState
): WorkspaceCleanupFacets[] {
  const multiplier = sort.direction === 'asc' ? 1 : -1
  return facets.toSorted(
    (left, right) =>
      comparePrimary(left, right, sort.field, multiplier) || compareTieBreaks(left, right)
  )
}

export function compareWorkspaceCleanupFacets(
  left: WorkspaceCleanupFacets,
  right: WorkspaceCleanupFacets,
  field: WorkspaceCleanupSortField,
  direction: WorkspaceCleanupSortDirectionState
): number {
  const multiplier = direction === 'asc' ? 1 : -1
  return comparePrimary(left, right, field, multiplier) || compareTieBreaks(left, right)
}

function comparePrimary(
  left: WorkspaceCleanupFacets,
  right: WorkspaceCleanupFacets,
  field: WorkspaceCleanupSortField,
  multiplier: number
): number {
  const absence = compareAbsence(left, right, field)
  if (absence !== 0) {
    return absence
  }
  return compareNatural(left, right, field) * multiplier
}

/** Non-zero only when exactly one side is absent for an absent-last field. */
function compareAbsence(
  left: WorkspaceCleanupFacets,
  right: WorkspaceCleanupFacets,
  field: WorkspaceCleanupSortField
): number {
  if (!ABSENT_LAST_FIELDS.has(field)) {
    return 0
  }
  const leftAbsent = isAbsent(left, field)
  const rightAbsent = isAbsent(right, field)
  if (leftAbsent === rightAbsent) {
    return 0
  }
  return leftAbsent ? 1 : -1
}

function isAbsent(facets: WorkspaceCleanupFacets, field: WorkspaceCleanupSortField): boolean {
  if (field === 'size') {
    return facets.sizeBytes === null
  }
  if (field === 'last-visited') {
    return facets.lastVisitedAt === null
  }
  if (field === 'created') {
    return facets.createdAt === null
  }
  if (field === 'ahead') {
    return facets.upstreamAhead === null
  }
  if (field === 'behind') {
    return facets.upstreamBehind === null
  }
  if (field === 'workspace-status') {
    return facets.workspaceStatus === null
  }
  if (field === 'review') {
    return !facets.review.hasReview
  }
  if (field === 'ticket') {
    return facets.ticketSources.length === 0
  }
  return false
}

function compareNatural(
  left: WorkspaceCleanupFacets,
  right: WorkspaceCleanupFacets,
  field: WorkspaceCleanupSortField
): number {
  switch (field) {
    case 'last-activity':
      return left.lastActivityAt - right.lastActivityAt
    case 'last-visited':
      return (left.lastVisitedAt ?? 0) - (right.lastVisitedAt ?? 0)
    case 'created':
      return (left.createdAt ?? 0) - (right.createdAt ?? 0)
    case 'size':
      return (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)
    case 'name':
      return left.displayName.localeCompare(right.displayName)
    case 'repo':
      return left.repoName.localeCompare(right.repoName)
    case 'path':
      return left.path.localeCompare(right.path)
    case 'host':
      return left.hostId.localeCompare(right.hostId)
    case 'workspace-status':
      return (left.workspaceStatus ?? '').localeCompare(right.workspaceStatus ?? '')
    case 'agent':
      return (
        getWorkspaceCleanupAgentRank(left.agentState) -
        getWorkspaceCleanupAgentRank(right.agentState)
      )
    case 'git':
      return getWorkspaceCleanupGitRank(left.gitState) - getWorkspaceCleanupGitRank(right.gitState)
    case 'ahead':
      return (left.upstreamAhead ?? 0) - (right.upstreamAhead ?? 0)
    case 'behind':
      return (left.upstreamBehind ?? 0) - (right.upstreamBehind ?? 0)
    case 'branch':
      return left.branch.localeCompare(right.branch)
    case 'review':
      return (
        getWorkspaceCleanupReviewRank(left.reviewState) -
          getWorkspaceCleanupReviewRank(right.reviewState) ||
        (left.review.label ?? '').localeCompare(right.review.label ?? '')
      )
    case 'ticket':
      return (
        left.ticketSources.length - right.ticketSources.length ||
        (left.ticketSources[0] ?? '').localeCompare(right.ticketSources[0] ?? '')
      )
    case 'local-context':
      return left.localContextCount - right.localContextCount
    case 'tier':
      return getWorkspaceCleanupTierRank(left.tier) - getWorkspaceCleanupTierRank(right.tier)
    case 'blocker-count':
      return (
        left.blockerCount - right.blockerCount ||
        getMaxBlockerSeverity(left) - getMaxBlockerSeverity(right)
      )
  }
}

/** Direction-independent so a flipped sort never reshuffles equal rows. */
function compareTieBreaks(left: WorkspaceCleanupFacets, right: WorkspaceCleanupFacets): number {
  return (
    left.lastActivityAt - right.lastActivityAt ||
    left.repoName.localeCompare(right.repoName) ||
    left.displayName.localeCompare(right.displayName) ||
    left.worktreeId.localeCompare(right.worktreeId)
  )
}

function getMaxBlockerSeverity(facets: WorkspaceCleanupFacets): number {
  let max = 0
  for (const blocker of facets.blockers) {
    max = Math.max(max, getWorkspaceCleanupBlockerSeverity(blocker))
  }
  return max
}

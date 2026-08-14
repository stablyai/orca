import type { WorkspaceCleanupFacets } from './workspace-cleanup-facets'
import type {
  WorkspaceCleanupActivityFilter,
  WorkspaceCleanupAgentFilter,
  WorkspaceCleanupContextFilterState,
  WorkspaceCleanupGitFilterState,
  WorkspaceCleanupLocationFilter,
  WorkspaceCleanupPresence,
  WorkspaceCleanupReviewFilterState,
  WorkspaceCleanupSafetyFilter,
  WorkspaceCleanupSizeFilter,
  WorkspaceCleanupStatusFilter,
  WorkspaceCleanupTicketFilter,
  WorkspaceCleanupTriState
} from '../../../../shared/workspace-cleanup-filter-model'

export const WORKSPACE_CLEANUP_DAY_MS = 24 * 60 * 60 * 1000

export function matchesWorkspaceCleanupTriState(
  filter: WorkspaceCleanupTriState,
  value: boolean
): boolean {
  return filter === 'any' || (filter === 'only' ? value : !value)
}

export function matchesWorkspaceCleanupPresence(
  filter: WorkspaceCleanupPresence,
  value: boolean
): boolean {
  return filter === 'any' || (filter === 'some' ? value : !value)
}

export function matchesWorkspaceCleanupActivity(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupActivityFilter,
  now: number
): boolean {
  if (filter.neverVisited && facets.lastVisitedAt !== null) {
    return false
  }
  if (filter.idleMinDays === null) {
    return true
  }
  const signalAt = getIdleSignalAt(facets, filter)
  // Why: a missing signal means Orca has no evidence of recent use, so it
  // reads as maximally idle rather than being filtered out.
  return signalAt === null || now - signalAt >= filter.idleMinDays * WORKSPACE_CLEANUP_DAY_MS
}

export function matchesWorkspaceCleanupSize(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupSizeFilter
): boolean {
  if (facets.sizeBytes === null) {
    return filter.includeUnsized
  }
  if (filter.minBytes !== null && facets.sizeBytes < filter.minBytes) {
    return false
  }
  return filter.maxBytes === null || facets.sizeBytes <= filter.maxBytes
}

export function matchesWorkspaceCleanupStatus(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupStatusFilter
): boolean {
  if (!matchesWorkspaceStatusList(facets, filter)) {
    return false
  }
  return (
    matchesWorkspaceCleanupTriState(filter.archived, facets.isArchived) &&
    matchesWorkspaceCleanupTriState(filter.pinned, facets.isPinned) &&
    matchesWorkspaceCleanupTriState(filter.unread, facets.isUnread) &&
    matchesWorkspaceCleanupTriState(filter.comment, facets.hasComment)
  )
}

export function matchesWorkspaceCleanupAgent(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupAgentFilter
): boolean {
  if (filter.states.length > 0 && !filter.states.includes(facets.agentState)) {
    return false
  }
  return matchesWorkspaceCleanupTriState(
    filter.retainedDoneAgents,
    facets.retainedDoneAgentCount > 0
  )
}

export function matchesWorkspaceCleanupGit(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupGitFilterState
): boolean {
  if (filter.states.length > 0 && !filter.states.includes(facets.gitState)) {
    return false
  }
  if (filter.minAhead !== null && (facets.upstreamAhead ?? 0) < filter.minAhead) {
    return false
  }
  if (filter.minBehind !== null && (facets.upstreamBehind ?? 0) < filter.minBehind) {
    return false
  }
  const branchQuery = filter.branchQuery.trim().toLowerCase()
  if (branchQuery && !facets.branch.toLowerCase().includes(branchQuery)) {
    return false
  }
  return (
    matchesWorkspaceCleanupTriState(filter.prunable, facets.isPrunable) &&
    matchesWorkspaceCleanupTriState(filter.locked, facets.isLocked)
  )
}

export function matchesWorkspaceCleanupReview(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupReviewFilterState
): boolean {
  if (!matchesWorkspaceCleanupPresence(filter.presence, facets.review.hasReview)) {
    return false
  }
  if (filter.states.length > 0) {
    if (facets.reviewState === null || !filter.states.includes(facets.reviewState)) {
      return false
    }
  }
  if (filter.providers.length === 0) {
    return true
  }
  return facets.review.provider !== null && filter.providers.includes(facets.review.provider)
}

export function matchesWorkspaceCleanupTicket(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupTicketFilter
): boolean {
  if (!matchesWorkspaceCleanupPresence(filter.presence, facets.ticketSources.length > 0)) {
    return false
  }
  return (
    filter.sources.length === 0 ||
    filter.sources.some((source) => facets.ticketSources.includes(source))
  )
}

export function matchesWorkspaceCleanupContext(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupContextFilterState
): boolean {
  if (!matchesWorkspaceCleanupPresence(filter.presence, facets.hasLocalContext)) {
    return false
  }
  return !filter.completelyEmpty || facets.isCompletelyEmpty
}

export function matchesWorkspaceCleanupLocation(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupLocationFilter
): boolean {
  if (filter.hostIds.length > 0 && !filter.hostIds.includes(facets.hostId)) {
    return false
  }
  if (filter.repoIds.length > 0 && !filter.repoIds.includes(facets.repoId)) {
    return false
  }
  const prefix = filter.pathPrefix.trim()
  return prefix.length === 0 || facets.path.startsWith(prefix)
}

export function matchesWorkspaceCleanupSafety(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupSafetyFilter
): boolean {
  if (filter.tiers.length > 0 && !filter.tiers.includes(facets.tier)) {
    return false
  }
  if (!matchesWorkspaceCleanupTriState(filter.dismissed, facets.isDismissed)) {
    return false
  }
  if (filter.selectableOnly && !facets.isSelectable) {
    return false
  }
  if (filter.blockers.length === 0) {
    return true
  }
  const hit = filter.blockers.some((blocker) => facets.blockers.includes(blocker))
  return filter.blockerMode === 'any-of' ? hit : !hit
}

function matchesWorkspaceStatusList(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupStatusFilter
): boolean {
  if (facets.workspaceStatus === null) {
    return filter.matchStatusless
  }
  return (
    filter.workspaceStatuses.length === 0 ||
    filter.workspaceStatuses.includes(facets.workspaceStatus)
  )
}

function getIdleSignalAt(
  facets: WorkspaceCleanupFacets,
  filter: WorkspaceCleanupActivityFilter
): number | null {
  switch (filter.idleSignal) {
    case 'last-visited':
      return facets.lastVisitedAt
    case 'last-activity':
      return facets.lastActivityAt
    case 'created':
      return facets.createdAt
  }
}

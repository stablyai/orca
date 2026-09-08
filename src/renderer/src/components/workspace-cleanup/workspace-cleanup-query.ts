import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import {
  buildWorkspaceCleanupFacetList,
  type WorkspaceCleanupFacetSources,
  type WorkspaceCleanupFacets
} from './workspace-cleanup-facets'
import {
  matchesWorkspaceCleanupActivity,
  matchesWorkspaceCleanupAgent,
  matchesWorkspaceCleanupContext,
  matchesWorkspaceCleanupGit,
  matchesWorkspaceCleanupLocation,
  matchesWorkspaceCleanupReview,
  matchesWorkspaceCleanupSafety,
  matchesWorkspaceCleanupSize,
  matchesWorkspaceCleanupStatus,
  matchesWorkspaceCleanupTicket
} from './workspace-cleanup-facet-matchers'
import { sortWorkspaceCleanupFacets } from './workspace-cleanup-facet-sort'
import type {
  WorkspaceCleanupFilterState,
  WorkspaceCleanupSortState
} from '../../../../shared/workspace-cleanup-filter-model'

export type WorkspaceCleanupQuery = {
  filters: WorkspaceCleanupFilterState
  sort: WorkspaceCleanupSortState
}

export type WorkspaceCleanupQueryResult = {
  /** Sorted rows that passed every facet. */
  rows: WorkspaceCleanupFacets[]
  /** Host-qualified keys of rows the user could queue, for the select-all affordance. */
  selectableIdentities: string[]
  totalCount: number
  matchedCount: number
}

export function matchesWorkspaceCleanupFilters(
  facets: WorkspaceCleanupFacets,
  filters: WorkspaceCleanupFilterState,
  now: number = Date.now()
): boolean {
  const query = filters.query.trim().toLowerCase()
  return matchesWorkspaceCleanupFiltersWithQuery(facets, filters, now, query)
}

function matchesWorkspaceCleanupFiltersWithQuery(
  facets: WorkspaceCleanupFacets,
  filters: WorkspaceCleanupFilterState,
  now: number,
  query: string
): boolean {
  if (query && !facets.searchText.includes(query)) {
    return false
  }
  return (
    matchesWorkspaceCleanupSafety(facets, filters.safety) &&
    matchesWorkspaceCleanupActivity(facets, filters.activity, now) &&
    matchesWorkspaceCleanupSize(facets, filters.size) &&
    matchesWorkspaceCleanupStatus(facets, filters.status) &&
    matchesWorkspaceCleanupAgent(facets, filters.agent) &&
    matchesWorkspaceCleanupGit(facets, filters.git) &&
    matchesWorkspaceCleanupReview(facets, filters.review) &&
    matchesWorkspaceCleanupTicket(facets, filters.ticket) &&
    matchesWorkspaceCleanupContext(facets, filters.context) &&
    matchesWorkspaceCleanupLocation(facets, filters.location)
  )
}

export function filterWorkspaceCleanupFacets(
  facets: readonly WorkspaceCleanupFacets[],
  filters: WorkspaceCleanupFilterState,
  now: number = Date.now()
): WorkspaceCleanupFacets[] {
  const query = filters.query.trim().toLowerCase()
  return facets.filter((entry) =>
    matchesWorkspaceCleanupFiltersWithQuery(entry, filters, now, query)
  )
}

export function runWorkspaceCleanupQuery(
  facets: readonly WorkspaceCleanupFacets[],
  query: WorkspaceCleanupQuery,
  now: number = Date.now()
): WorkspaceCleanupQueryResult {
  const matched = filterWorkspaceCleanupFacets(facets, query.filters, now)
  const rows = sortWorkspaceCleanupFacets(matched, query.sort)
  return {
    rows,
    selectableIdentities: rows.filter((row) => row.isSelectable).map((row) => row.identity),
    totalCount: facets.length,
    matchedCount: rows.length
  }
}

/** One-shot convenience for callers holding raw scan candidates. */
export function queryWorkspaceCleanupCandidates(
  candidates: readonly WorkspaceCleanupCandidate[],
  query: WorkspaceCleanupQuery,
  sources: WorkspaceCleanupFacetSources = {},
  now: number = Date.now()
): WorkspaceCleanupQueryResult {
  return runWorkspaceCleanupQuery(buildWorkspaceCleanupFacetList(candidates, sources), query, now)
}

/**
 * Per-facet-group match counts for badge/count rendering. Each entry counts the
 * rows that would survive if only that group were applied, so a UI can show how
 * much each facet is costing without re-running the whole pipeline per group.
 */
export function countWorkspaceCleanupFacetMatches(
  facets: readonly WorkspaceCleanupFacets[],
  filters: WorkspaceCleanupFilterState,
  now: number = Date.now()
): Record<keyof Omit<WorkspaceCleanupFilterState, 'query'>, number> {
  return {
    activity: count(facets, (row) => matchesWorkspaceCleanupActivity(row, filters.activity, now)),
    size: count(facets, (row) => matchesWorkspaceCleanupSize(row, filters.size)),
    status: count(facets, (row) => matchesWorkspaceCleanupStatus(row, filters.status)),
    agent: count(facets, (row) => matchesWorkspaceCleanupAgent(row, filters.agent)),
    git: count(facets, (row) => matchesWorkspaceCleanupGit(row, filters.git)),
    review: count(facets, (row) => matchesWorkspaceCleanupReview(row, filters.review)),
    ticket: count(facets, (row) => matchesWorkspaceCleanupTicket(row, filters.ticket)),
    context: count(facets, (row) => matchesWorkspaceCleanupContext(row, filters.context)),
    location: count(facets, (row) => matchesWorkspaceCleanupLocation(row, filters.location)),
    safety: count(facets, (row) => matchesWorkspaceCleanupSafety(row, filters.safety))
  }
}

function count(
  facets: readonly WorkspaceCleanupFacets[],
  predicate: (facets: WorkspaceCleanupFacets) => boolean
): number {
  let total = 0
  for (const entry of facets) {
    if (predicate(entry)) {
      total += 1
    }
  }
  return total
}

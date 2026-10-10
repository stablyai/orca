import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getLiveAgentStatusByWorktreeId } from '@/lib/worktree-activity-state'
import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupFilterState,
  WorkspaceCleanupSortState
} from '../../../../shared/workspace-cleanup-filter-model'
import {
  countWorkspaceCleanupMeasuredRows,
  type WorkspaceCleanupFacets
} from './workspace-cleanup-facets'
import {
  countWorkspaceCleanupFacetMatches,
  filterWorkspaceCleanupFacets,
  runWorkspaceCleanupQuery
} from './workspace-cleanup-query'
import {
  buildWorkspaceCleanupReviewLookup,
  type WorkspaceCleanupReviewInfo
} from './workspace-cleanup-presentation'
import type {
  WorkspaceCleanupFacetCounts,
  WorkspaceCleanupFacetOptions
} from './workspace-cleanup-facet-panel-model'
import {
  buildWorkspaceCleanupSizeIndex,
  buildWorkspaceCleanupWorktreeIndex,
  countWorkspaceCleanupCandidateIds
} from './workspace-cleanup-host-identity'
import {
  computeWorkspaceCleanupFacetList,
  computeWorkspaceCleanupReviewInfoIndex,
  createWorkspaceCleanupFacetListCache,
  createWorkspaceCleanupReviewInfoCache
} from './workspace-cleanup-facet-row-caches'

export type WorkspaceCleanupFacetRows = {
  rows: WorkspaceCleanupFacets[]
  selectableIdentities: string[]
  facetMatchedIdentities: ReadonlySet<string>
  matchedCount: number
  totalCount: number
  facetCounts: WorkspaceCleanupFacetCounts
  options: WorkspaceCleanupFacetOptions
  reviewInfoByWorktreeId: ReadonlyMap<string, WorkspaceCleanupReviewInfo>
  sizeByWorktreeId: ReadonlyMap<string, number>
  /** 0 means the workspace-space scan has never produced a usable size. */
  measuredSizeCount: number
  unmeasuredSizeCount: number
}

const EMPTY_FACET_COUNTS: WorkspaceCleanupFacetCounts = Object.freeze({
  activity: 0,
  size: 0,
  status: 0,
  agent: 0,
  git: 0,
  review: 0,
  ticket: 0,
  context: 0,
  location: 0,
  safety: 0
})

const EMPTY_FACET_OPTIONS: WorkspaceCleanupFacetOptions = Object.freeze({
  workspaceStatuses: Object.freeze([]),
  hostIds: Object.freeze([]),
  repos: Object.freeze([]),
  reviewProviders: Object.freeze([])
})

/**
 * Joins the scan rows with everything the flat list filters and sorts on:
 * renderer-only signals (visits, live agents, review cache, dismissals) plus
 * sizes from the EXISTING workspace-space scan — no second scanner.
 *
 * Per-candidate work is cached on candidate object identity (see
 * workspace-cleanup-facet-row-caches) so streaming ticks touch only changed
 * rows and no-op ticks skip every downstream pass.
 */
export function useWorkspaceCleanupFacetRows({
  candidates,
  filters,
  sort,
  now,
  facetPanelOpen = true
}: {
  candidates: readonly WorkspaceCleanupCandidate[]
  filters: WorkspaceCleanupFilterState
  sort: WorkspaceCleanupSortState
  now: number
  /** Facet counts/options are only rendered inside the filter popover; pass
   * false while it is closed to skip their O(N) passes entirely. */
  facetPanelOpen?: boolean
}): WorkspaceCleanupFacetRows {
  const sources = useAppStore(
    useShallow((s) => ({
      worktreesByRepo: s.worktreesByRepo,
      hostedReviewCache: s.hostedReviewCache,
      repos: s.repos,
      settings: s.settings,
      // Statuses are a top-level UI-slice field, not part of GlobalSettings.
      workspaceStatuses: s.workspaceStatuses,
      lastVisitedAtByWorktreeId: s.lastVisitedAtByWorktreeId,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      dismissals: s.workspaceCleanupDismissals,
      spaceWorktrees: s.workspaceSpaceAnalysis?.worktrees ?? null,
      spaceMeasurements: s.workspaceSpaceMeasurements
    }))
  )
  const { hostedReviewCache, repos, settings, worktreesByRepo } = sources
  const candidateIdCounts = useMemo(
    () => countWorkspaceCleanupCandidateIds(candidates),
    [candidates]
  )
  // Why: each per-candidate cache lives in one memo together with the derived
  // context it is keyed on — the memo deps ARE the cache invalidation, no refs
  // (ref writes during render are unsafe under concurrent rendering), and
  // interior fills are content-addressed and idempotent.
  const reviewContext = useMemo(
    () => ({
      sources: { hostedReviewCache, repos, settings, worktreesByRepo },
      lookup: buildWorkspaceCleanupReviewLookup({ repos, worktreesByRepo }),
      cache: createWorkspaceCleanupReviewInfoCache()
    }),
    [hostedReviewCache, repos, settings, worktreesByRepo]
  )
  const facetContext = useMemo(
    () => ({
      worktreeById: buildWorkspaceCleanupWorktreeIndex(worktreesByRepo, repos),
      workspaceStatuses: sources.workspaceStatuses,
      cache: createWorkspaceCleanupFacetListCache()
    }),
    [repos, sources.workspaceStatuses, worktreesByRepo]
  )
  const liveAgentStatusByWorktreeId = useMemo(
    () => getLiveAgentStatusByWorktreeId(sources.agentStatusByPaneKey, sources.tabsByWorktree, now),
    [now, sources.agentStatusByPaneKey, sources.tabsByWorktree]
  )
  // Why (STA-4343): dismissals are keyed by host-qualified identity, so the keys
  // ARE identities — comparing them to a bare worktreeId never matched.
  const dismissedIdentities = useMemo(
    () => new Set(Object.keys(sources.dismissals)),
    [sources.dismissals]
  )

  const reviewInfoByWorktreeId = useMemo(
    () =>
      computeWorkspaceCleanupReviewInfoIndex({
        candidates,
        candidateIdCounts,
        reviewSources: reviewContext.sources,
        reviewLookup: reviewContext.lookup,
        cache: reviewContext.cache
      }),
    [candidateIdCounts, candidates, reviewContext]
  )

  const completedSizeByWorktreeId = useMemo(
    () => buildWorkspaceCleanupSizeIndex(sources.spaceWorktrees, candidates),
    [candidates, sources.spaceWorktrees]
  )
  const sizeByWorktreeId = useMemo(() => {
    if (sources.spaceMeasurements.length === 0) {
      return completedSizeByWorktreeId
    }
    return new Map([
      ...completedSizeByWorktreeId,
      ...buildWorkspaceCleanupSizeIndex(sources.spaceMeasurements, candidates)
    ])
  }, [candidates, completedSizeByWorktreeId, sources.spaceMeasurements])

  const facets = useMemo(
    () =>
      computeWorkspaceCleanupFacetList({
        candidates,
        sources: {
          worktreeById: facetContext.worktreeById,
          workspaceStatuses: facetContext.workspaceStatuses,
          sizeBytesByWorktreeId: sizeByWorktreeId,
          lastVisitedAtByWorktreeId: sources.lastVisitedAtByWorktreeId,
          liveAgentStatusByWorktreeId,
          reviewInfoByWorktreeId,
          dismissedIdentities
        },
        cache: facetContext.cache
      }),
    [
      candidates,
      dismissedIdentities,
      facetContext,
      liveAgentStatusByWorktreeId,
      reviewInfoByWorktreeId,
      sizeByWorktreeId,
      sources.lastVisitedAtByWorktreeId
    ]
  )

  const result = useMemo(
    () => runWorkspaceCleanupQuery(facets, { filters, sort }, now),
    [facets, filters, now, sort]
  )
  const facetFilters = useMemo<WorkspaceCleanupFilterState>(
    () => ({
      query: '',
      activity: filters.activity,
      size: filters.size,
      status: filters.status,
      agent: filters.agent,
      git: filters.git,
      review: filters.review,
      ticket: filters.ticket,
      context: filters.context,
      location: filters.location,
      safety: filters.safety
    }),
    [
      filters.activity,
      filters.agent,
      filters.context,
      filters.git,
      filters.location,
      filters.review,
      filters.safety,
      filters.size,
      filters.status,
      filters.ticket
    ]
  )
  const facetCounts = useMemo(
    () =>
      facetPanelOpen
        ? countWorkspaceCleanupFacetMatches(facets, facetFilters, now)
        : EMPTY_FACET_COUNTS,
    [facetFilters, facetPanelOpen, facets, now]
  )
  // Identity churn here is harmless: the only consumer reads the latest set
  // inside a useEffectEvent body and never keys an effect on it.
  const facetMatchedIdentities = useMemo<ReadonlySet<string>>(
    () =>
      new Set(filterWorkspaceCleanupFacets(facets, facetFilters, now).map((row) => row.identity)),
    [facetFilters, facets, now]
  )
  const measuredSizeCount = useMemo(() => countWorkspaceCleanupMeasuredRows(facets), [facets])
  const unmeasuredSizeCount = facets.length - measuredSizeCount

  const options = useMemo<WorkspaceCleanupFacetOptions>(() => {
    if (!facetPanelOpen) {
      return EMPTY_FACET_OPTIONS
    }
    const repoLabels = new Map<string, string>()
    for (const row of facets) {
      if (!repoLabels.has(row.repoId)) {
        repoLabels.set(row.repoId, row.repoName)
      }
    }
    return {
      workspaceStatuses: sources.workspaceStatuses.map((status) => ({
        id: status.id,
        label: status.label
      })),
      hostIds: [...new Set(facets.map((row) => row.hostId))].sort(),
      repos: [...repoLabels].map(([id, label]) => ({ id, label })),
      reviewProviders: [
        ...new Set(
          facets
            .map((row) => row.review.provider)
            .filter((provider): provider is HostedReviewProvider => provider !== null)
        )
      ].sort()
    }
  }, [facetPanelOpen, facets, sources.workspaceStatuses])

  return {
    rows: result.rows,
    selectableIdentities: result.selectableIdentities,
    facetMatchedIdentities,
    matchedCount: result.matchedCount,
    totalCount: result.totalCount,
    facetCounts,
    options,
    reviewInfoByWorktreeId,
    sizeByWorktreeId,
    measuredSizeCount,
    unmeasuredSizeCount
  }
}

import type { LiveAgentWorktreeStatus } from '@/lib/worktree-activity-state'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import {
  buildWorkspaceCleanupFacets,
  type WorkspaceCleanupFacetSources,
  type WorkspaceCleanupFacets
} from './workspace-cleanup-facets'
import {
  getWorkspaceCleanupReviewInfo,
  type WorkspaceCleanupRendererStateInputs,
  type WorkspaceCleanupReviewInfo,
  type WorkspaceCleanupReviewLookup
} from './workspace-cleanup-presentation'
import {
  getWorkspaceCleanupCandidateHostId,
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity
} from './workspace-cleanup-host-identity'

/**
 * Streaming ticks replace only the candidate objects they touched, so all
 * per-candidate work here is cached on candidate object identity; unchanged
 * rows reuse their previous facet/review objects and the row array itself
 * keeps identity when nothing changed, which is what lets React.memo and
 * downstream memos hold.
 *
 * The caches are owned by useMemo keyed on their invalidation inputs (never
 * refs — ref writes during render are unsafe under concurrent rendering).
 * Filling them during render is safe because they are content-addressed and
 * idempotent: a replayed or discarded render stores the same value for the
 * same key.
 */
export type WorkspaceCleanupReviewInfoCache = WeakMap<
  WorkspaceCleanupCandidate,
  WorkspaceCleanupReviewInfo
>

export function createWorkspaceCleanupReviewInfoCache(): WorkspaceCleanupReviewInfoCache {
  return new WeakMap()
}

export function computeWorkspaceCleanupReviewInfoIndex(args: {
  candidates: readonly WorkspaceCleanupCandidate[]
  candidateIdCounts: ReadonlyMap<string, number>
  reviewSources: WorkspaceCleanupRendererStateInputs
  reviewLookup: WorkspaceCleanupReviewLookup
  cache: WorkspaceCleanupReviewInfoCache
}): Map<string, WorkspaceCleanupReviewInfo> {
  const { candidates, candidateIdCounts, reviewSources, reviewLookup, cache } = args
  const infos = new Map<string, WorkspaceCleanupReviewInfo>()
  for (const candidate of candidates) {
    let info = cache.get(candidate)
    if (info === undefined) {
      info = getWorkspaceCleanupReviewInfo(candidate, reviewSources, reviewLookup)
      cache.set(candidate, info)
    }
    infos.set(
      getWorkspaceCleanupHostIdentity(
        getWorkspaceCleanupCandidateHostId(candidate),
        candidate.worktreeId
      ),
      info
    )
    if (candidateIdCounts.get(candidate.worktreeId) === 1) {
      infos.set(candidate.worktreeId, info)
    }
  }
  return infos
}

type FacetCacheEntry = {
  facet: WorkspaceCleanupFacets
  sizeBytes: number | null | undefined
  lastVisitedAt: number | undefined
  agentState: LiveAgentWorktreeStatus | undefined
  review: WorkspaceCleanupReviewInfo | undefined
  isDismissed: boolean
}

export type WorkspaceCleanupFacetListCache = {
  byCandidate: WeakMap<WorkspaceCleanupCandidate, FacetCacheEntry>
  lastList: WorkspaceCleanupFacets[]
}

export function createWorkspaceCleanupFacetListCache(): WorkspaceCleanupFacetListCache {
  return { byCandidate: new WeakMap(), lastList: [] }
}

export function computeWorkspaceCleanupFacetList(args: {
  candidates: readonly WorkspaceCleanupCandidate[]
  sources: Required<Omit<WorkspaceCleanupFacetSources, 'workspaceStatuses'>> & {
    workspaceStatuses: readonly WorkspaceStatusDefinition[]
  }
  cache: WorkspaceCleanupFacetListCache
}): WorkspaceCleanupFacets[] {
  const { candidates, sources, cache } = args
  const list = candidates.map((candidate) => {
    const hostIdentity = getWorkspaceCleanupHostIdentity(
      getWorkspaceCleanupCandidateHostId(candidate),
      candidate.worktreeId
    )
    // Per-id projections mirror buildWorkspaceCleanupFacets' lookups; the
    // cached facet is valid only while every projected input is unchanged.
    const sizeBytes =
      sources.sizeBytesByWorktreeId.get(hostIdentity) ??
      sources.sizeBytesByWorktreeId.get(candidate.worktreeId)
    const lastVisitedAt = sources.lastVisitedAtByWorktreeId[candidate.worktreeId]
    const agentState = sources.liveAgentStatusByWorktreeId.get(candidate.worktreeId)
    const review =
      sources.reviewInfoByWorktreeId.get(hostIdentity) ??
      sources.reviewInfoByWorktreeId.get(candidate.worktreeId)
    const isDismissed = sources.dismissedIdentities.has(
      getWorkspaceCleanupCandidateIdentity(candidate)
    )
    const cached = cache.byCandidate.get(candidate)
    if (
      cached &&
      cached.sizeBytes === sizeBytes &&
      cached.lastVisitedAt === lastVisitedAt &&
      cached.agentState === agentState &&
      cached.review === review &&
      cached.isDismissed === isDismissed
    ) {
      return cached.facet
    }
    const facet = buildWorkspaceCleanupFacets(candidate, sources)
    cache.byCandidate.set(candidate, {
      facet,
      sizeBytes,
      lastVisitedAt,
      agentState,
      review,
      isDismissed
    })
    return facet
  })
  // Why: reusing the previous array identity when no row changed lets every
  // downstream memo skip its O(N) pass on no-op streaming ticks.
  const previous = cache.lastList
  if (previous.length === list.length && list.every((facet, index) => facet === previous[index])) {
    return previous
  }
  cache.lastList = list
  return list
}

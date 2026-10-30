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
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'

/** Cache by candidate identity and reuse unchanged row arrays. useMemo owns invalidation; content-addressed/idempotent fills survive discarded renders without unsafe ref mutation. */
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
    // Mirror facet-builder inputs so cached rows invalidate only when projected evidence changes.
    const sizeBytes =
      sources.sizeBytesByWorktreeId.get(hostIdentity) ??
      sources.sizeBytesByWorktreeId.get(candidate.worktreeId)
    const lastVisitedAt = getWorktreeVisitTimestamp(sources.lastVisitedAtByWorktreeId, {
      id: candidate.worktreeId,
      hostId: getWorkspaceCleanupCandidateHostId(candidate)
    })
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
  // Reuse unchanged row-array identity so downstream memos skip O(N) passes on no-op ticks.
  const previous = cache.lastList
  if (previous.length === list.length && list.every((facet, index) => facet === previous[index])) {
    return previous
  }
  cache.lastList = list
  return list
}

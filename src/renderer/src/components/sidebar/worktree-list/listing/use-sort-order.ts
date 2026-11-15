import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { persistWorktreeSortOrderByHost } from '@/lib/workspace/persistence/worktree-sort-order-persistence'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  NO_LIVE_SMART_SORT_SOURCES,
  rankWorktreesForSort
} from '../../../../../../shared/sidebar-list/sorting/smart-sort'
import type { WorkspaceSortBy as SortBy } from '../../../../../../shared/workspace-view/workspace-row-sort'
import {
  ranksFollowPersistedOrder,
  smartSortPhase
} from '../../../../../../shared/sidebar-list/sorting/smart-sort-phase'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import { useSidebarListSession } from '@/components/sidebar/sidebar-feed/sidebar-list-session'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

// Compute settled order synchronously; selection side effects must not reorder rows under the user.
function useSettledSidebarWorktreeSortOrder(args: {
  repoMap: Map<string, Repo>
  sortBy: SortBy
}): string[] {
  const { repoMap, sortBy } = args
  // Coalesce sort bumps so bursts cannot make rows jump.
  const settledSortEpoch = useAppStore((s) => s.settledSortEpoch)
  const sortOrderEpoch = useAppStore((s) => s.sortOrderEpoch)

  // Why a latching ref: a live signal makes Smart authoritative for the session, even after that activity ends.
  const sessionHasHadLiveSmartSignal = useRef(false)
  // Why: cold Smart and Manual fallback rows rank by sortOrder and never persist it, so they can follow another client's save without looping.
  const followsPersistedRanks = ranksFollowPersistedOrder(
    sortBy,
    sessionHasHadLiveSmartSignal.current
  )
  const persistedRankTrigger = followsPersistedRanks ? sortOrderEpoch : 0

  const recomputedSort = useMemo(() => {
    const state = useAppStore.getState()
    const ranking = rankWorktreesForSort({
      worktrees: getIndexedAllWorktrees(selectWorktreesByRepo(state)).filter(
        (worktree) => !worktree.isArchived
      ),
      sortBy,
      latched: sessionHasHadLiveSmartSignal.current,
      repoMap,
      now: Date.now(),
      sources: state
    })
    return {
      // Why host identity: same-id copies on two machines are separate cards with their own ranks.
      sortedIds: ranking.sorted.map(getWorktreeHostIdentity),
      detectedLiveSmartSignal: ranking.detectedLiveSmartSignal
    }
    // settledSortEpoch is an intentional trigger not read in the memo; its change signals a recompute.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [settledSortEpoch, persistedRankTrigger, repoMap, sortBy])
  // Why: stable ID order prevents rank-only refreshes from echoing an unchanged snapshot.
  const sortedIds = useReusedArrayIdentity(recomputedSort.sortedIds)

  // Why: main's sleeping retention lives as long as this list.
  useSidebarListSession()

  // Why after commit: a discarded render must not latch Smart onto a live signal that never committed.
  useEffect(() => {
    if (recomputedSort.detectedLiveSmartSignal) {
      sessionHasHadLiveSmartSignal.current = true
    }
  }, [recomputedSort.detectedLiveSmartSignal])

  // Why: only persist during live sessions so cold start reads the persisted order instead of overwriting it.
  useEffect(() => {
    if (
      sortedIds.length === 0 ||
      smartSortPhase(sortBy, sessionHasHadLiveSmartSignal.current) !== 'live'
    ) {
      return
    }
    // Why: sortOrder lives in each host's worktreeMeta, so persist each host's ids on that host.
    persistWorktreeSortOrderByHost(
      useAppStore.getState(),
      sortedIds.map(getWorktreeIdFromHostIdentity)
    )
  }, [sortedIds, sortBy])

  return sortedIds
}

/** Rank by host-owned stamps without clocks, settle windows or latches; same-ID host copies retain separate ranks. */
function useStampSidebarWorktreeSortOrder(args: {
  repoMap: Map<string, Repo>
  sortBy: SortBy
}): string[] {
  const { repoMap, sortBy } = args
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const ranked = useMemo(
    () =>
      rankWorktreesForSort({
        worktrees: getIndexedAllWorktrees(worktreesByRepo).filter(
          (worktree) => !worktree.isArchived
        ),
        sortBy,
        latched: false,
        repoMap,
        // Stamps read no clock and no live sources.
        now: 0,
        sources: NO_LIVE_SMART_SORT_SOURCES
      }).sorted.map(getWorktreeHostIdentity),
    [worktreesByRepo, repoMap, sortBy]
  )
  const sortedIds = useReusedArrayIdentity(ranked)
  // Why: main's sleeping retention lives as long as this list.
  useSidebarListSession()
  return sortedIds
}

export const useSidebarWorktreeSortOrder = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? useStampSidebarWorktreeSortOrder
  : useSettledSidebarWorktreeSortOrder

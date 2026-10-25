import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { persistWorktreeSortOrderByHost } from '@/lib/worktree-sort-order-persistence'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  NO_LIVE_SMART_SORT_SOURCES,
  rankWorktreesForSort,
  type SortBy
} from '../../../../../../shared/sidebar-list/smart-sort'
import {
  ranksFollowPersistedOrder,
  smartSortPhase
} from '../../../../../../shared/sidebar-list/smart-sort-phase'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import { useSidebarListSession } from '@/lib/sidebar-list-session'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

// ── Stable sort order ──────────────────────────────────────────
// Why sortEpoch (not selection): selection side-effects (clearing isUnread, PR-cache refresh) must not reorder the sidebar under the user.
// Why useMemo not useEffect: order must be computed synchronously before the worktrees memo reads it.
function useSettledSidebarWorktreeSortOrder(args: {
  repoMap: Map<string, Repo>
  sortBy: SortBy
}): string[] {
  const { repoMap, sortBy } = args
  // Why settled (not live): the store coalesces bump bursts so rows don't jump (store/settled-sort-epoch.ts).
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
      worktrees: getAllWorktreesFromState(state).filter((worktree) => !worktree.isArchived),
      sortBy,
      latched: sessionHasHadLiveSmartSignal.current,
      repoMap,
      now: Date.now(),
      sources: state
    })
    return {
      sortedIds: ranking.sorted.map((w) => w.id),
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
    persistWorktreeSortOrderByHost(useAppStore.getState(), sortedIds)
  }, [sortedIds, sortBy])

  return sortedIds
}

/**
 * Switch on: the order is a pure read of the owning hosts' stamps on the rows, so a re-list is
 * what re-sorts. No settle window, latch, saved Smart order or create grace. Host identities, so a
 * same-id pair on two hosts keeps its own ranks.
 */
function useStampSidebarWorktreeSortOrder(args: {
  repoMap: Map<string, Repo>
  sortBy: SortBy
}): string[] {
  const { repoMap, sortBy } = args
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const ranked = useMemo(
    () =>
      rankWorktreesForSort({
        worktrees: getAllWorktreesFromState({ worktreesByRepo }).filter(
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

import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { track } from '@/lib/telemetry'
import { persistWorktreeSortOrderByHost } from '@/lib/worktree-sort-order-persistence'
import type { Repo } from '../../../../../../shared/repo-types'
import { rankWorktreesForSort, type SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import type {
  SmartClass,
  WorktreeAttention
} from '../../../../../../shared/sidebar-list/smart-attention'
import {
  ranksFollowPersistedOrder,
  smartSortPhase
} from '../../../../../../shared/sidebar-list/smart-sort-phase'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import { useSidebarListSession } from '@/lib/sidebar-list-session'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'

function trackSmartClassDistribution(attention: ReadonlyMap<string, WorktreeAttention>): void {
  let class1 = 0
  let class2 = 0
  let class3 = 0
  let class4 = 0
  let class5 = 0
  for (const info of attention.values()) {
    if (info.cls === 1) {
      class1++
    } else if (info.cls === 2) {
      class2++
    } else if (info.cls === 3) {
      class3++
    } else if (info.cls === 4) {
      class4++
    } else {
      class5++
    }
  }
  track('smart_sort_class_distribution', {
    class_1: class1,
    class_2: class2,
    class_3: class3,
    class_4: class4,
    class_5: class5,
    total_worktrees: attention.size
  })
}

// ── Stable sort order ──────────────────────────────────────────
// Why sortEpoch (not selection): selection side-effects (clearing isUnread, PR-cache refresh) must not reorder the sidebar under the user.
// Why useMemo not useEffect: order must be computed synchronously before the worktrees memo reads it.
export function useSidebarWorktreeSortOrder(args: {
  repoMap: Map<string, Repo>
  sortBy: SortBy
}): string[] {
  const { repoMap, sortBy } = args
  // Why settled (not live): the store coalesces bump bursts so rows don't jump (store/settled-sort-epoch.ts).
  const settledSortEpoch = useAppStore((s) => s.settledSortEpoch)
  const sortOrderEpoch = useAppStore((s) => s.sortOrderEpoch)
  // Switch point: the host's stamps arrive on the rows, so a re-list is what re-sorts.
  const stampedRows = useAppStore((s) => (ORCA_SIDEBAR_INPUTS_IS_MAIN ? s.worktreesByRepo : null))

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
      attentionByWorktree: ranking.attentionByWorktree,
      detectedLiveSmartSignal: ranking.detectedLiveSmartSignal
    }
    // settledSortEpoch and stampedRows are triggers not read in the memo; a change signals a recompute.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [settledSortEpoch, persistedRankTrigger, stampedRows, repoMap, sortBy])
  // Why: stable ID order prevents rank-only refreshes from echoing an unchanged snapshot.
  const sortedIds = useReusedArrayIdentity(recomputedSort.sortedIds)

  // Why: main's copy of the latch and retention lives as long as this list, as the ref above does.
  useSidebarListSession(sortBy, sortedIds)

  // Why after commit: a discarded render must not latch Smart onto a live signal that never committed.
  useEffect(() => {
    if (recomputedSort.detectedLiveSmartSignal) {
      sessionHasHadLiveSmartSignal.current = true
    }
  }, [recomputedSort.detectedLiveSmartSignal])

  // Why a ref of prior class: fire class_1_promotion only on transitions into Class 1, not every recompute that stays there.
  const prevClassByWorktreeIdRef = useRef<Map<string, SmartClass>>(new Map())
  // Why gate the first observation: an empty prev-class map makes every existing Class-1 worktree look freshly promoted; treat the first pass as a silent baseline.
  const hasObservedSmartOnceRef = useRef<boolean>(false)

  useEffect(() => {
    const attention = recomputedSort.attentionByWorktree
    if (sortBy !== 'smart' || !attention) {
      // Why reset: leaving Smart drops the prior-class map (and first-observation gate) so re-entry doesn't fire stale promotions.
      prevClassByWorktreeIdRef.current = new Map()
      hasObservedSmartOnceRef.current = false
      return
    }
    const next = new Map<string, SmartClass>()
    const isFirstObservation = !hasObservedSmartOnceRef.current
    for (const [worktreeId, info] of attention) {
      const prev = prevClassByWorktreeIdRef.current.get(worktreeId)
      if (!isFirstObservation && info.cls === 1 && prev !== 1 && info.cause) {
        track('smart_sort_class_1_promotion', { cause: info.cause })
      }
      next.set(worktreeId, info.cls)
    }
    prevClassByWorktreeIdRef.current = next
    hasObservedSmartOnceRef.current = true
  }, [sortBy, recomputedSort.attentionByWorktree, recomputedSort.sortedIds])

  // Why retry on recomputation: Smart may activate before attention hydrates; fire once, then stay quiet until the user leaves Smart.
  const hasTrackedSmartDistributionRef = useRef(false)
  useEffect(() => {
    if (sortBy !== 'smart') {
      hasTrackedSmartDistributionRef.current = false
      return
    }
    const attention = recomputedSort.attentionByWorktree
    if (hasTrackedSmartDistributionRef.current || !attention || attention.size === 0) {
      return
    }
    trackSmartClassDistribution(attention)
    hasTrackedSmartDistributionRef.current = true
  }, [sortBy, recomputedSort.attentionByWorktree, recomputedSort.sortedIds])

  // Why fire on the transition: switching away from Smart is the signal; compare via ref so a round-trip doesn't double-fire.
  const prevSortByRef = useRef(sortBy)
  useEffect(() => {
    const prev = prevSortByRef.current
    prevSortByRef.current = sortBy
    if (prev === 'smart' && sortBy === 'recent') {
      track('smart_to_recent_switch', {})
    }
  }, [sortBy])

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

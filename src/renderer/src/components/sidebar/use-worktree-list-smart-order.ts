import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import type { Repo, Worktree } from '../../../../shared/types'
import { track } from '@/lib/telemetry'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { persistWorktreeSortOrderByHost } from '@/lib/worktree-sort-order-persistence'
import { buildWorktreeComparator, compareWorktreeSortLabel, type SortBy } from './smart-sort'
import {
  buildAttentionByWorktree,
  hasFreshAttributedAgentStatus,
  type SmartClass,
  type WorktreeAttention
} from './smart-attention'
import { useReusedArrayIdentity } from './use-reused-array-identity'

// Debounce re-sort after a sortEpoch bump so background score changes don't jar row positions.
const SORT_SETTLE_MS = 3_000

export function useWorktreeListSmartOrder(args: {
  allWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  sortBy: SortBy
  sortEpoch: number
}): string[] {
  const { allWorktrees, repoMap, sortBy, sortEpoch } = args
  // Non-archived count detects add/remove so the debounce below can apply immediately.
  const worktreeCount = useMemo(
    () => allWorktrees.reduce((count, worktree) => count + (worktree.isArchived ? 0 : 1), 0),
    [allWorktrees]
  )
  // Why debounce: time-decaying scores would otherwise jump rows on every epoch; structural changes bypass it.
  const [debouncedSortEpoch, setDebouncedSortEpoch] = useState(sortEpoch)
  const prevWorktreeCountRef = useRef(worktreeCount)
  useEffect(() => {
    if (debouncedSortEpoch === sortEpoch) {
      return
    }
    const structuralChange = worktreeCount !== prevWorktreeCountRef.current
    prevWorktreeCountRef.current = worktreeCount
    // Why: manual drag/drop is direct manipulation; the settle-window delay would make a successful drop look broken.
    if (structuralChange || sortBy === 'manual') {
      setDebouncedSortEpoch(sortEpoch)
      return
    }
    const timer = setTimeout(() => setDebouncedSortEpoch(sortEpoch), SORT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [sortEpoch, debouncedSortEpoch, worktreeCount, sortBy])

  // Why a latching ref: a live signal makes Smart authoritative for the session, even after that activity ends.
  const sessionHasHadLiveSmartSignal = useRef(false)
  // Why: sortEpoch avoids selection-driven reorder, synchronous memo feeds rows, and the ref shares attention with telemetry.
  const lastAttentionByWorktreeRef = useRef<Map<string, WorktreeAttention> | null>(null)
  const recomputedSortedIds = useMemo(() => {
    const state = useAppStore.getState()
    const nonArchivedWorktrees = getAllWorktreesFromState(state).filter(
      (worktree) => !worktree.isArchived
    )
    const now = Date.now()
    // Why cold-start detection: agent-status hydrates async, so the warm comparator would collapse all to Class 4; keep the persisted order until a live signal appears.
    if (sortBy === 'smart' && !sessionHasHadLiveSmartSignal.current) {
      // Why tabHasLivePty over tab.ptyId: slept terminals keep tab.ptyId as a wake hint, so it'd falsely keep cold-start ordering off.
      const hasAnyLivePty = Object.values(state.tabsByWorktree)
        .flat()
        .some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
      if (
        hasAnyLivePty ||
        hasFreshAttributedAgentStatus(state.agentStatusByPaneKey, now, state.tabsByWorktree)
      ) {
        sessionHasHadLiveSmartSignal.current = true
      } else {
        nonArchivedWorktrees.sort(
          (a, b) => b.sortOrder - a.sortOrder || compareWorktreeSortLabel(a, b)
        )
        lastAttentionByWorktreeRef.current = null
        return nonArchivedWorktrees.map((worktree) => worktree.id)
      }
    }
    // Why precompute: hot sort — one attention map keeps comparator lookups O(1).
    const attentionByWorktree =
      sortBy === 'smart'
        ? buildAttentionByWorktree(
            nonArchivedWorktrees,
            state.tabsByWorktree,
            state.agentStatusByPaneKey,
            state.runtimePaneTitlesByTabId,
            state.ptyIdsByTabId,
            now,
            state.migrationUnsupportedByPtyId,
            state.terminalLayoutsByTabId
          )
        : new Map<string, WorktreeAttention>()
    lastAttentionByWorktreeRef.current = sortBy === 'smart' ? attentionByWorktree : null
    nonArchivedWorktrees.sort(buildWorktreeComparator(sortBy, repoMap, now, attentionByWorktree))
    return nonArchivedWorktrees.map((worktree) => worktree.id)
    // debouncedSortEpoch is an intentional trigger not read in the memo; its change (debounced) signals a recompute.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSortEpoch, repoMap, sortBy])
  // Why: stable ID order prevents rank-only refreshes from echoing an unchanged snapshot.
  const sortedIds = useReusedArrayIdentity(recomputedSortedIds)

  // Why: compare prior class transitions, with the first observation serving only as a baseline.
  const prevClassByWorktreeIdRef = useRef<Map<string, SmartClass>>(new Map())
  const hasObservedSmartOnceRef = useRef(false)
  useEffect(() => {
    const attention = lastAttentionByWorktreeRef.current
    if (sortBy !== 'smart' || !attention) {
      // Why reset: re-entering Smart must not report promotions from a stale prior session.
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
  }, [sortBy, recomputedSortedIds])

  // Why retry on recomputation: attention may hydrate after Smart activates; report once per Smart session.
  const hasTrackedSmartDistributionRef = useRef(false)
  useEffect(() => {
    if (sortBy !== 'smart') {
      hasTrackedSmartDistributionRef.current = false
      return
    }
    if (hasTrackedSmartDistributionRef.current) {
      return
    }
    const attention = lastAttentionByWorktreeRef.current
    if (!attention || attention.size === 0) {
      return
    }
    let class1 = 0,
      class2 = 0,
      class3 = 0,
      class4 = 0
    for (const info of attention.values()) {
      if (info.cls === 1) {
        class1++
      } else if (info.cls === 2) {
        class2++
      } else if (info.cls === 3) {
        class3++
      } else {
        class4++
      }
    }
    track('smart_sort_class_distribution', {
      class_1: class1,
      class_2: class2,
      class_3: class3,
      class_4: class4,
      total_worktrees: attention.size
    })
    hasTrackedSmartDistributionRef.current = true
  }, [sortBy, recomputedSortedIds])

  // Why fire on the transition: a ref prevents a round trip from double-reporting the switch.
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
    if (sortBy !== 'smart' || sortedIds.length === 0 || !sessionHasHadLiveSmartSignal.current) {
      return
    }
    // Why: sortOrder lives in each host's worktreeMeta, so persist each host's ids on that host.
    persistWorktreeSortOrderByHost(useAppStore.getState(), sortedIds)
  }, [sortedIds, sortBy])
  return sortedIds
}

import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { useOrderHeldWhileEngaged } from '@/components/sidebar/worktree-list/listing/use-order-hold'
import type { Worktree } from '../../../../shared/worktree/types'
import { rankWorktreesForSort } from '../../../../shared/sidebar-list/sorting/smart-sort'
import { ranksFollowPersistedOrder } from '../../../../shared/sidebar-list/sorting/smart-sort-phase'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

/** A bot's workspaces in the project list's Smart order, held still while the pointer is on the bots list. */
export function useBotWorkspaceOrder(worktrees: readonly Worktree[]): Worktree[] {
  // Re-rank when the project list does, so a bot's lines never move more often than its rows.
  const settledSortEpoch = useAppStore((s) => s.settledSortEpoch)
  const sortOrderEpoch = useAppStore((s) => s.sortOrderEpoch)
  // Latched like the project list: once live, Smart stays live after the activity ends.
  const latchedRef = useRef(false)
  const persistedRankTrigger = ranksFollowPersistedOrder('smart', latchedRef.current)
    ? sortOrderEpoch
    : 0
  const ranking = useMemo(() => {
    const state = useAppStore.getState()
    const ranked = rankWorktreesForSort({
      worktrees: [...worktrees],
      sortBy: 'smart',
      latched: latchedRef.current,
      repoMap: getIndexedRepoMap(state.repos),
      now: Date.now(),
      sources: state
    })
    return {
      ids: ranked.sorted.map(getWorktreeHostIdentity),
      detectedLiveSmartSignal: ranked.detectedLiveSmartSignal
    }
    // The epochs are recompute triggers, not reads.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [worktrees, settledSortEpoch, persistedRankTrigger])
  // After commit, so a discarded render cannot latch on a signal that never showed.
  useEffect(() => {
    if (ranking.detectedLiveSmartSignal) {
      latchedRef.current = true
    }
  }, [ranking.detectedLiveSmartSignal])
  const shownIds = useOrderHeldWhileEngaged(ranking.ids, 'smart', 'bots')
  return useMemo(() => {
    const byId = new Map<string, Worktree>(
      worktrees.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
    )
    return shownIds.flatMap((id) => byId.get(id) ?? [])
  }, [shownIds, worktrees])
}

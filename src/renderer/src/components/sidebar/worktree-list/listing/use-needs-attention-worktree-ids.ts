import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { buildAttentionByWorktree } from '../../smart-attention'

const NO_WORKTREE_IDS: ReadonlySet<string> = new Set()

/** Ids of non-archived workspaces whose agent is blocked on the user (Smart sort's Class 1). */
export function getNeedsAttentionWorktreeIds(state: AppState, now: number): Set<string> {
  const worktrees = getAllWorktreesFromState(state).filter((worktree) => !worktree.isArchived)
  const attention = buildAttentionByWorktree(
    worktrees,
    state.tabsByWorktree,
    state.agentStatusByPaneKey,
    state.runtimePaneTitlesByTabId,
    state.ptyIdsByTabId,
    now,
    state.migrationUnsupportedByPtyId,
    state.terminalLayoutsByTabId
  )
  const ids = new Set<string>()
  for (const [worktreeId, info] of attention) {
    if (info.cls === 1) {
      ids.add(worktreeId)
    }
  }
  return ids
}

/**
 * Membership of the sidebar's "Needs you" section.
 *
 * Why settledSortEpoch: the same coalesced trigger as the Smart sort, so the section and
 * the sort agree and a burst of status writes moves rows once, not on every write.
 */
export function useNeedsAttentionWorktreeIds(enabled: boolean): ReadonlySet<string> {
  const settledSortEpoch = useAppStore((s) => s.settledSortEpoch)
  const idsKey = useMemo(() => {
    if (!enabled) {
      return ''
    }
    return [...getNeedsAttentionWorktreeIds(useAppStore.getState(), Date.now())].sort().join('\n')
    // settledSortEpoch is an intentional trigger not read in the memo; its change signals a recompute.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, settledSortEpoch])
  // Why a joined key: an unchanged membership keeps its Set identity, so rows don't rebuild.
  return useMemo(() => (idsKey ? new Set(idsKey.split('\n')) : NO_WORKTREE_IDS), [idsKey])
}

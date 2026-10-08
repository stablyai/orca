import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { SORT_SETTLE_MS } from '@/store/settled-sort-epoch'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeAttention } from '../../smart-attention'
import {
  buildProjectAttentionFromState,
  hasLiveSmartAttentionSignal
} from '../../project-attention-order'

// Why settledSortEpoch: like the Smart worktree sort, projects reorder on coalesced
// activity bumps instead of on every agent-status tick, so rows don't jump under the cursor.
// Undefined while cold: the Attention order then keeps the persisted Smart snapshot.
export function useProjectAttentionByWorktree(
  enabled: boolean,
  worktrees: readonly Worktree[]
): Map<string, WorktreeAttention> | undefined {
  const settledSortEpoch = useAppStore((s) => s.settledSortEpoch)
  const settledActiveTitleEpoch = useSettledActiveTitleAttentionEpoch(enabled)
  // Why a latch: once live evidence appeared, attention stays authoritative for the session.
  const sessionHasHadLiveSignal = useRef(false)
  const attention = useMemo(() => {
    if (!enabled) {
      return undefined
    }
    const state = useAppStore.getState()
    if (!sessionHasHadLiveSignal.current && !hasLiveSmartAttentionSignal(state)) {
      return undefined
    }
    return buildProjectAttentionFromState(state, worktrees)
    // settledSortEpoch and settledActiveTitleEpoch are intentional triggers not read in the memo.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, worktrees, settledSortEpoch, settledActiveTitleEpoch])
  // Why after commit: a discarded render must not latch a signal that never committed.
  useEffect(() => {
    if (attention) {
      sessionHasHadLiveSignal.current = true
    }
  }, [attention])
  return attention
}

// Why: active-worktree title reclassifications skip sortEpoch, yet they change the active
// project's rank. Coalesce them over the same settle window so rows still don't jump per tick.
function useSettledActiveTitleAttentionEpoch(enabled: boolean): number {
  const epoch = useAppStore((s) => (enabled ? s.activeTitleAttentionEpoch : 0))
  const [settled, setSettled] = useState(epoch)
  useEffect(() => {
    if (epoch === settled) {
      return
    }
    const timer = setTimeout(() => setSettled(epoch), SORT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [epoch, settled])
  return settled
}

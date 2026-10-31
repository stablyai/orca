import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { notifyTiledAgentsPaneCapReached } from '@/components/tab-group/tiled-agents-cap-notification'
import { selectTiledAgentsReconcileKey } from '@/components/tab-group/tiled-pane-attention'

/** Brings one worktree's agent cards in line every time its reconcile key changes: the
 *  experiment flag or its ordered agent tab ids. Never on an unrelated store publication,
 *  so a settled, never-enabled worktree runs this once per mount. */
export function useAgentCardsReconciler(worktreeId: string): void {
  const reconcileKey = useAppStore((state) => selectTiledAgentsReconcileKey(state, worktreeId))

  useEffect(() => {
    const { overflowTabIds } = useAppStore.getState().syncAgentCards(worktreeId)
    if (overflowTabIds.length > 0) {
      notifyTiledAgentsPaneCapReached()
    }
  }, [reconcileKey, worktreeId])
}

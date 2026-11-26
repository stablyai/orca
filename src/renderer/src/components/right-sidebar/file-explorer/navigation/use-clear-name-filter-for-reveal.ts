import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

/** Clears the search query once per reveal so the tree can show it; a later query cancels that reveal. */
export function useClearNameFilterForReveal({
  activeWorktreeId,
  hasQuery,
  clearQuery
}: {
  activeWorktreeId: string | null
  hasQuery: boolean
  clearQuery: () => void
}): void {
  const pendingReveal = useAppStore((s) => s.pendingExplorerReveal)
  const clearPendingExplorerReveal = useAppStore((s) => s.clearPendingExplorerReveal)
  const handledRevealRef = useRef<AppState['pendingExplorerReveal']>(null)
  useEffect(() => {
    if (!pendingReveal || pendingReveal.worktreeId !== activeWorktreeId) {
      return
    }
    if (handledRevealRef.current === pendingReveal) {
      // Why: a query typed after the clear replaces the reveal so it cannot resolve under hidden rows or stay stuck.
      if (hasQuery) {
        clearPendingExplorerReveal()
      }
      return
    }
    handledRevealRef.current = pendingReveal
    if (hasQuery) {
      clearQuery()
    }
  }, [pendingReveal, activeWorktreeId, hasQuery, clearQuery, clearPendingExplorerReveal])
}

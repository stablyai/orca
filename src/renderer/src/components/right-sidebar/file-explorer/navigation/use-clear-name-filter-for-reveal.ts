import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

/** Clears the name filter once per reveal shown in the files tree; a later query cancels that reveal. */
export function useClearNameFilterForReveal({
  activeWorktreeId,
  visibleFilesWorktreePath,
  hasNameFilter,
  setNameFilterQuery
}: {
  activeWorktreeId: string | null
  visibleFilesWorktreePath: string | null
  hasNameFilter: boolean
  setNameFilterQuery: Dispatch<SetStateAction<string>>
}): void {
  const pendingReveal = useAppStore((s) => s.pendingExplorerReveal)
  const clearPendingExplorerReveal = useAppStore((s) => s.clearPendingExplorerReveal)
  const handledRevealRef = useRef<AppState['pendingExplorerReveal']>(null)
  useEffect(() => {
    if (
      !pendingReveal ||
      pendingReveal.worktreeId !== activeWorktreeId ||
      !visibleFilesWorktreePath
    ) {
      return
    }
    if (handledRevealRef.current === pendingReveal) {
      // Why: a query typed after the clear replaces the reveal so it cannot resolve against filtered rows or stay stuck.
      if (hasNameFilter) {
        clearPendingExplorerReveal()
      }
      return
    }
    handledRevealRef.current = pendingReveal
    if (hasNameFilter) {
      setNameFilterQuery('')
    }
  }, [
    pendingReveal,
    activeWorktreeId,
    visibleFilesWorktreePath,
    hasNameFilter,
    setNameFilterQuery,
    clearPendingExplorerReveal
  ])
}

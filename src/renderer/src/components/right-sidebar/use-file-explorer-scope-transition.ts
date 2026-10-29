import { useLayoutEffect, useRef } from 'react'
import type { useFileExplorerTreePaneState } from './use-file-explorer-tree-pane-state'
import type { useFileExplorerSelection } from './useFileExplorerSelection'

/** Clears transient interactions when scope changes within a worktree, preserving directory caches and undo state. */
export function useFileExplorerScopeTransition({
  displayRootPath,
  activeWorktreeId,
  paneState,
  selection,
  setBgMenuOpen
}: {
  displayRootPath: string | null
  activeWorktreeId: string | null
  paneState: ReturnType<typeof useFileExplorerTreePaneState>
  selection: ReturnType<typeof useFileExplorerSelection>
  setBgMenuOpen: (open: boolean) => void
}): void {
  const previous = useRef({ displayRootPath, activeWorktreeId })
  useLayoutEffect(() => {
    const changed =
      previous.current.displayRootPath !== displayRootPath &&
      previous.current.activeWorktreeId === activeWorktreeId
    previous.current = { displayRootPath, activeWorktreeId }
    if (!changed) {
      return
    }
    selection.resetSelection()
    if (paneState.inlineInputState.inlineInput) {
      paneState.inlineInputState.dismissInlineInput()
    }
    paneState.rowScrolling.cancelRevealTimers()
    setBgMenuOpen(false)
    if (paneState.scrollRef.current) {
      paneState.scrollRef.current.scrollTop = 0
    }
  }, [displayRootPath, activeWorktreeId, paneState, selection, setBgMenuOpen])
}

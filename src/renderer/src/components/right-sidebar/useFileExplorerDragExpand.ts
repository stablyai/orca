import { useCallback } from 'react'
import { useAppStore } from '@/store'

type UseFileExplorerDragExpandParams = {
  activeWorktreeId: string | null
  expanded: Set<string>
  toggleDir: (worktreeId: string, dirPath: string) => void
}

type UseFileExplorerDragExpandResult = {
  handleDragExpandDir: (dirPath: string) => void
  handleNativeDragExpandDir: (dirPath: string) => void
}

export function useFileExplorerDragExpand({
  activeWorktreeId,
  expanded,
  toggleDir
}: UseFileExplorerDragExpandParams): UseFileExplorerDragExpandResult {
  const handleDragExpandDir = useCallback(
    (dirPath: string) => {
      if (!activeWorktreeId || expanded.has(dirPath)) {
        return
      }
      toggleDir(activeWorktreeId, dirPath)
    },
    [activeWorktreeId, expanded, toggleDir]
  )

  // Why: native drag expand must be expand-only (never collapse). The preload
  // captures native drop events in the capture phase and stops propagation,
  // so React's handleDrop never fires and the expand timer is never cleared.
  // If revealInExplorer already expanded the folder before the timer fires,
  // a toggleDir call would collapse it. Reading current state at call time
  // also avoids stale-closure issues with the 500ms timer callback.
  const handleNativeDragExpandDir = useCallback(
    (dirPath: string) => {
      if (!activeWorktreeId) {
        return
      }
      useAppStore.setState((state) => {
        const current = state.expandedDirs[activeWorktreeId] ?? new Set<string>()
        if (current.has(dirPath)) {
          return state
        }
        const next = new Set(current)
        next.add(dirPath)
        return { expandedDirs: { ...state.expandedDirs, [activeWorktreeId]: next } }
      })
    },
    [activeWorktreeId]
  )

  return { handleDragExpandDir, handleNativeDragExpandDir }
}

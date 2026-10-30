import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { FILE_EXPLORER_FULL_ROOT, type ExplorerRootOption } from './file-explorer-display-root'

export function useFileExplorerRootNavigation(
  worktreeId: string | null,
  choice: string,
  options: ExplorerRootOption[] | null
) {
  const [returnTarget, setReturnTarget] = useState<{ worktreeId: string; choice: string } | null>(
    null
  )
  const selectRoot = useCallback(
    (value: string) => {
      if (!worktreeId) {
        return
      }
      setReturnTarget(null)
      const state = useAppStore.getState()
      state.clearPendingExplorerReveal()
      state.setExplorerDisplayRootForWorktree(worktreeId, value)
    },
    [worktreeId]
  )
  const revealOutsideRoot = useCallback(() => {
    if (!worktreeId || choice === FILE_EXPLORER_FULL_ROOT) {
      return
    }
    setReturnTarget({ worktreeId, choice })
    useAppStore.getState().setExplorerDisplayRootForWorktree(worktreeId, FILE_EXPLORER_FULL_ROOT)
  }, [worktreeId, choice])
  const returnRoot =
    choice === FILE_EXPLORER_FULL_ROOT && returnTarget?.worktreeId === worktreeId
      ? (options?.find((option) => option.value === returnTarget.choice) ?? null)
      : null
  return { selectRoot, revealOutsideRoot, returnRoot }
}

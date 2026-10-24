import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import {
  FILE_EXPLORER_FULL_ROOT,
  getExplorerDisplayRootPath,
  getExplorerParentPath,
  type ExplorerRootOption
} from './file-explorer-display-root'

export function useFileExplorerRootNavigation(
  worktreeId: string | null,
  choice: string,
  options: ExplorerRootOption[] | null,
  worktreePath: string | null
) {
  const [browsedRoots, setBrowsedRoots] = useState<Record<string, string>>({})
  const [returnTarget, setReturnTarget] = useState<{ worktreeId: string; choice: string } | null>(
    null
  )
  const browsedRootPath = worktreeId ? (browsedRoots[worktreeId] ?? null) : null
  const navigateToPath = useCallback(
    (path: string) => {
      if (!worktreeId || !path) {
        return
      }
      useAppStore.getState().clearPendingExplorerReveal()
      setBrowsedRoots((current) => ({ ...current, [worktreeId]: path }))
    },
    [worktreeId]
  )
  const backToWorkspace = useCallback(() => {
    if (!worktreeId) {
      return
    }
    useAppStore.getState().clearPendingExplorerReveal()
    setBrowsedRoots((current) => {
      const next = { ...current }
      delete next[worktreeId]
      return next
    })
  }, [worktreeId])
  const selectRoot = useCallback(
    (value: string) => {
      if (!worktreeId) {
        return
      }
      setReturnTarget(null)
      const state = useAppStore.getState()
      state.clearPendingExplorerReveal()
      state.setExplorerDisplayRootForWorktree(worktreeId, value)
      setBrowsedRoots((current) => {
        const next = { ...current }
        delete next[worktreeId]
        return next
      })
    },
    [worktreeId]
  )
  const revealOutsideRoot = useCallback(() => {
    if (!worktreeId || (choice === FILE_EXPLORER_FULL_ROOT && !browsedRootPath)) {
      return
    }
    setReturnTarget((current) =>
      choice !== FILE_EXPLORER_FULL_ROOT ? { worktreeId, choice } : current
    )
    setBrowsedRoots((current) => {
      const next = { ...current }
      delete next[worktreeId]
      return next
    })
    useAppStore.getState().setExplorerDisplayRootForWorktree(worktreeId, FILE_EXPLORER_FULL_ROOT)
  }, [browsedRootPath, worktreeId, choice])
  const goUp = useCallback(() => {
    const currentRoot = getExplorerDisplayRootPath(worktreePath, choice, browsedRootPath)
    if (currentRoot) {
      navigateToPath(getExplorerParentPath(currentRoot))
    }
  }, [browsedRootPath, choice, navigateToPath, worktreePath])
  const openFolder = useCallback(async () => {
    const path = await window.api.repos.pickDirectory()
    if (path) {
      navigateToPath(path)
    }
  }, [navigateToPath])
  const returnRoot =
    !browsedRootPath &&
    choice === FILE_EXPLORER_FULL_ROOT &&
    returnTarget?.worktreeId === worktreeId
      ? (options?.find((option) => option.value === returnTarget.choice) ?? null)
      : null
  return {
    browsedRootPath,
    selectRoot,
    navigateToPath,
    goUp,
    openFolder,
    backToWorkspace,
    revealOutsideRoot,
    returnRoot
  }
}

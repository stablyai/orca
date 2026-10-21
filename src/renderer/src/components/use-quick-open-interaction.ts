import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getFileExplorerOperationOwnerFromState } from './right-sidebar/file-explorer-operation-owner'

export function useQuickOpenInteraction(worktreeId: string | null): {
  opening: boolean
  invalidate: () => void
  begin: () => { isCurrent: () => boolean; assertCurrent: () => void; finish: () => void }
} {
  const generation = useRef({ value: 0 })
  const [opening, setOpening] = useState(false)
  const invalidate = useCallback(() => {
    generation.current.value++
    setOpening(false)
  }, [])
  useEffect(() => {
    const currentGeneration = generation.current
    let rootPath = useAppStore.getState().getKnownWorktreeById(worktreeId ?? '')?.path
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      const nextRootPath = state.getKnownWorktreeById(worktreeId ?? '')?.path
      if (
        nextRootPath !== rootPath ||
        state.activeModal !== previous.activeModal ||
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId ||
        ((state.settings !== previous.settings ||
          state.repos !== previous.repos ||
          state.worktreesByRepo !== previous.worktreesByRepo ||
          state.detectedWorktreesByRepo !== previous.detectedWorktreesByRepo ||
          state.restoredRuntimeHostIdByWorkspaceSessionKey !==
            previous.restoredRuntimeHostIdByWorkspaceSessionKey ||
          state.folderWorkspaces !== previous.folderWorkspaces ||
          state.projectGroups !== previous.projectGroups) &&
          JSON.stringify(getFileExplorerOperationOwnerFromState(state, worktreeId)) !==
            JSON.stringify(getFileExplorerOperationOwnerFromState(previous, worktreeId)))
      ) {
        invalidate()
      }
      rootPath = nextRootPath
    })
    return () => {
      unsubscribe()
      currentGeneration.value++
    }
  }, [invalidate, worktreeId])
  const begin = useCallback(() => {
    const request = ++generation.current.value
    setOpening(true)
    const isCurrent = (): boolean => {
      const state = useAppStore.getState()
      return (
        generation.current.value === request &&
        state.activeModal === 'quick-open' &&
        state.activeWorktreeId === worktreeId
      )
    }
    return {
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) {
          throw new Error('Quick Open selection was cancelled.')
        }
      },
      finish: () => {
        if (isCurrent()) {
          setOpening(false)
        }
      }
    }
  }, [worktreeId])
  return { opening, invalidate, begin }
}

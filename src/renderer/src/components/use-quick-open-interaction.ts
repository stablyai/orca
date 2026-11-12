import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { selectFileListWorktree } from '@/store/workspaces/selection/known-worktree-selection'
import { getFileExplorerOperationOwnerFromState } from './right-sidebar/file-explorer/navigation/file-explorer-operation-owner'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

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
    let rootPath = selectFileListWorktree(useAppStore.getState(), worktreeId)?.path
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      const nextRootPath = selectFileListWorktree(state, worktreeId)?.path
      if (
        nextRootPath !== rootPath ||
        state.activeModal !== previous.activeModal ||
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId ||
        ((state.settings !== previous.settings ||
          state.repos !== previous.repos ||
          selectWorktreesByRepo(state) !== selectWorktreesByRepo(previous) ||
          selectDetectedWorktreesByRepo(state) !== selectDetectedWorktreesByRepo(previous) ||
          state.restoredRuntimeHostIdByWorkspaceSessionKey !==
            previous.restoredRuntimeHostIdByWorkspaceSessionKey ||
          selectFolderWorkspaces(state) !== selectFolderWorkspaces(previous) ||
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

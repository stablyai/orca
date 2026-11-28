import { useCallback, useEffect } from 'react'
import { useAppStore } from '@/store/index'
import {
  getExecutionHostIdForWorktree,
  runtimeEnvironmentIdOrLocalUnlessTwin
} from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  isFileSearchResultOwnerCurrent,
  type FileSearchResultOwner
} from '@/lib/files/search/file-search-result-owner'

export function useFileSearchScope({
  activeWorktreeId,
  worktreePath,
  cancelPendingSearch,
  updateActiveSearchState
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
  cancelPendingSearch: () => void
  updateActiveSearchState: (updates: { results: null; resultOwner: null; error: null }) => void
}) {
  const runtimeEnvironmentId = useAppStore((state) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(state, activeWorktreeId)
  )
  const executionHostId = useAppStore((state) =>
    getExecutionHostIdForWorktree(state, activeWorktreeId)
  )
  const isCurrentOwner = useCallback(
    (owner: FileSearchResultOwner | null | undefined) =>
      isFileSearchResultOwnerCurrent(
        owner,
        activeWorktreeId,
        worktreePath,
        runtimeEnvironmentId,
        executionHostId
      ),
    [activeWorktreeId, worktreePath, runtimeEnvironmentId, executionHostId]
  )
  useEffect(() => {
    if (activeWorktreeId) {
      const saved = useAppStore.getState().fileSearchStateByWorktree[activeWorktreeId]
      if ((saved?.results || saved?.error) && !isCurrentOwner(saved.resultOwner)) {
        cancelPendingSearch()
        updateActiveSearchState({ results: null, resultOwner: null, error: null })
      }
    }
  }, [activeWorktreeId, isCurrentOwner, updateActiveSearchState, cancelPendingSearch])
  return isCurrentOwner
}

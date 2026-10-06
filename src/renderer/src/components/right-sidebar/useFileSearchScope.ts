import { useCallback, useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import {
  isFileSearchResultOwnerCurrent,
  type FileSearchResultOwner
} from '@/lib/file-search-result-owner'

export function useFileSearchScope({
  activeWorktreeId,
  worktreePath,
  explorerView,
  executeSearch,
  cancelPendingSearch,
  updateActiveSearchState
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
  explorerView: 'files' | 'search'
  executeSearch: (query: string) => void
  cancelPendingSearch: () => void
  updateActiveSearchState: (updates: { results: null; resultOwner: null; error: null }) => void
}) {
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
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
    if (explorerView !== 'search') {
      cancelPendingSearch()
    } else if (activeWorktreeId) {
      const saved = useAppStore.getState().fileSearchStateByWorktree[activeWorktreeId]
      if (
        saved?.query.trim() &&
        !saved.results &&
        !saved.error &&
        saved.seedRequestId === undefined
      ) {
        executeSearch(saved.query)
      }
    }
  }, [
    explorerView,
    activeWorktreeId,
    isCurrentOwner,
    updateActiveSearchState,
    cancelPendingSearch,
    executeSearch
  ])
  return isCurrentOwner
}

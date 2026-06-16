import { useCallback, useEffect, useRef } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { searchRuntimeFiles } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import type { SearchResult } from '../../../../shared/types'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MAX_RESULTS = 2000

type UpdateSearchState = (updates: { loading?: boolean; results?: SearchResult | null }) => void

type UseFileSearchRunnerArgs = {
  activeWorktreeId: string | null
  worktreePath: string | null
  updateActiveSearchState: UpdateSearchState
}

export function useFileSearchRunner({
  activeWorktreeId,
  worktreePath,
  updateActiveSearchState
}: UseFileSearchRunnerArgs): {
  executeSearch: (query: string) => void
  cancelPendingSearch: () => void
} {
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Why: runtime searches can finish out of order; ids keep stale results
  // from overwriting the newest query state.
  const latestSearchIdRef = useRef(0)

  const cancelPendingSearch = useCallback(() => {
    latestSearchIdRef.current += 1
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    updateActiveSearchState({ loading: false })
  }, [updateActiveSearchState])

  const executeSearch = useCallback(
    (query: string) => {
      latestSearchIdRef.current += 1
      const searchId = latestSearchIdRef.current

      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }

      if (!query.trim() || !worktreePath || !activeWorktreeId) {
        updateActiveSearchState({ results: null, loading: false })
        return
      }

      updateActiveSearchState({ loading: true })
      searchTimerRef.current = setTimeout(async () => {
        searchTimerRef.current = null
        try {
          const state = useAppStore.getState()
          const connectionId = getConnectionId(activeWorktreeId) ?? undefined
          const activeSearchState = state.fileSearchStateByWorktree[activeWorktreeId]
          const results = await searchRuntimeFiles(
            {
              settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
              worktreeId: activeWorktreeId,
              worktreePath,
              connectionId
            },
            {
              query: query.trim(),
              rootPath: worktreePath,
              caseSensitive: activeSearchState?.caseSensitive ?? false,
              wholeWord: activeSearchState?.wholeWord ?? false,
              useRegex: activeSearchState?.useRegex ?? false,
              includePattern: activeSearchState?.includePattern || undefined,
              excludePattern: activeSearchState?.excludePattern || undefined,
              maxResults: SEARCH_MAX_RESULTS
            }
          )
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({ results })
          }
        } catch (err) {
          console.error('Search failed:', err)
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({
              results: { files: [], totalMatches: 0, truncated: false }
            })
          }
        } finally {
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({ loading: false })
          }
        }
      }, SEARCH_DEBOUNCE_MS)
    },
    [activeWorktreeId, updateActiveSearchState, worktreePath]
  )

  useEffect(() => cancelPendingSearch, [cancelPendingSearch])

  return { executeSearch, cancelPendingSearch }
}

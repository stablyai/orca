import { useCallback, useEffect, useRef } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import {
  createFileSearchResultOwner,
  type FileSearchResultOwner
} from '@/lib/file-search-result-owner'
import {
  createEmptyRuntimeFileSearchResult,
  getRuntimeFileSearchRejectedField
} from '@/runtime/runtime-file-search-bounds'
import { searchRuntimeFiles } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import type { SearchResult } from '../../../../shared/types'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MAX_RESULTS = 2000

type UpdateSearchState = (updates: {
  loading?: boolean
  results?: SearchResult | null
  resultOwner?: FileSearchResultOwner | null
}) => void

type UseFileSearchRunnerArgs = {
  activeWorktreeId: string | null
  worktreePath: string | null
  updateActiveSearchState: UpdateSearchState
}

type CancelPendingSearchOptions = {
  discardResults?: boolean
}

export function useFileSearchRunner({
  activeWorktreeId,
  worktreePath,
  updateActiveSearchState
}: UseFileSearchRunnerArgs): {
  executeSearch: (query: string) => void
  cancelPendingSearch: (options?: CancelPendingSearchOptions) => boolean
} {
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeSearchControllerRef = useRef<AbortController | null>(null)
  // Why: runtime searches can finish out of order; ids keep stale results
  // from overwriting the newest query state.
  const latestSearchIdRef = useRef(0)

  const cancelPendingSearch = useCallback(
    (options: CancelPendingSearchOptions = {}) => {
      const hadPendingSearch =
        searchTimerRef.current !== null || activeSearchControllerRef.current !== null
      latestSearchIdRef.current += 1
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
      activeSearchControllerRef.current?.abort()
      activeSearchControllerRef.current = null
      updateActiveSearchState(
        options.discardResults && hadPendingSearch
          ? { results: null, resultOwner: null, loading: false }
          : { loading: false }
      )
      return hadPendingSearch
    },
    [updateActiveSearchState]
  )

  const executeSearch = useCallback(
    (query: string) => {
      latestSearchIdRef.current += 1
      const searchId = latestSearchIdRef.current

      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
      activeSearchControllerRef.current?.abort()
      activeSearchControllerRef.current = null

      if (!worktreePath || !activeWorktreeId) {
        updateActiveSearchState({ results: null, resultOwner: null, loading: false })
        return
      }

      const currentSearchState = useAppStore.getState().fileSearchStateByWorktree[activeWorktreeId]
      if (
        getRuntimeFileSearchRejectedField({
          query,
          includePattern: currentSearchState?.includePattern || undefined,
          excludePattern: currentSearchState?.excludePattern || undefined
        })
      ) {
        const runtimeSettings = getRightSidebarWorktreeRuntimeSettings(activeWorktreeId)
        updateActiveSearchState({
          results: createEmptyRuntimeFileSearchResult(),
          resultOwner: createFileSearchResultOwner(activeWorktreeId, runtimeSettings),
          loading: false
        })
        return
      }

      if (!query.trim()) {
        updateActiveSearchState({ results: null, resultOwner: null, loading: false })
        return
      }

      updateActiveSearchState({ loading: true })
      searchTimerRef.current = setTimeout(async () => {
        searchTimerRef.current = null
        const controller = new AbortController()
        activeSearchControllerRef.current = controller
        // Why: results can outlive the selected worktree; clicks must reuse the route that produced them.
        const runtimeSettings = getRightSidebarWorktreeRuntimeSettings(activeWorktreeId)
        const resultOwner = createFileSearchResultOwner(activeWorktreeId, runtimeSettings)
        try {
          const state = useAppStore.getState()
          const connectionId = getConnectionId(activeWorktreeId) ?? undefined
          const activeSearchState = state.fileSearchStateByWorktree[activeWorktreeId]
          if (
            getRuntimeFileSearchRejectedField({
              query,
              includePattern: activeSearchState?.includePattern || undefined,
              excludePattern: activeSearchState?.excludePattern || undefined
            })
          ) {
            if (latestSearchIdRef.current === searchId) {
              updateActiveSearchState({
                results: createEmptyRuntimeFileSearchResult(),
                resultOwner,
                loading: false
              })
            }
            return
          }
          const results = await searchRuntimeFiles(
            {
              settings: runtimeSettings,
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
            },
            controller.signal
          )
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({ results, resultOwner })
          }
        } catch (err) {
          if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
            return
          }
          console.error('Search failed:', err)
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({
              results: { files: [], totalMatches: 0, truncated: false },
              resultOwner
            })
          }
        } finally {
          if (activeSearchControllerRef.current === controller) {
            activeSearchControllerRef.current = null
          }
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({ loading: false })
          }
        }
      }, SEARCH_DEBOUNCE_MS)
    },
    [activeWorktreeId, updateActiveSearchState, worktreePath]
  )

  useEffect(
    () => () => {
      cancelPendingSearch({ discardResults: true })
    },
    [activeWorktreeId, cancelPendingSearch, worktreePath]
  )

  return { executeSearch, cancelPendingSearch }
}

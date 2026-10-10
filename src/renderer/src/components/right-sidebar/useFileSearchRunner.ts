import { readIpcErrorDetail } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
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
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import type { SearchResult } from '../../../../shared/code-search-types'
import type { FileSearchResultsQuery } from '@/store/slices/editor/types/file-search-worktree-state'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MAX_RESULTS = 2000

type UpdateSearchState = (updates: {
  error?: string | null
  loading?: boolean
  results?: SearchResult | null
  resultOwner?: FileSearchResultOwner | null
  resultsQuery?: FileSearchResultsQuery | null
}) => void

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
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
  )
  const executionHostId = useAppStore((state) =>
    getExecutionHostIdForWorktree(state, activeWorktreeId)
  )
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Why: runtime searches can finish out of order; ids keep stale results
  // from overwriting the newest query state.
  const latestSearchIdRef = useRef(0)
  const searchControllerRef = useRef<AbortController | null>(null)

  const cancelPendingSearch = useCallback(() => {
    const interrupted = searchControllerRef.current !== null || searchTimerRef.current !== null
    searchControllerRef.current?.abort()
    searchControllerRef.current = null
    latestSearchIdRef.current += 1
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    updateActiveSearchState({
      loading: false,
      ...(interrupted ? { results: null, resultOwner: null } : {})
    })
  }, [updateActiveSearchState])

  const executeSearch = useCallback(
    (query: string) => {
      searchControllerRef.current?.abort()
      searchControllerRef.current = null
      latestSearchIdRef.current += 1
      const searchId = latestSearchIdRef.current
      updateActiveSearchState({ error: null })

      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }

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
        const runtimeSettings = { activeRuntimeEnvironmentId: runtimeEnvironmentId }
        updateActiveSearchState({
          results: createEmptyRuntimeFileSearchResult(),
          resultOwner: createFileSearchResultOwner(activeWorktreeId, runtimeSettings, {
            rootPath: worktreePath,
            executionHostId
          }),
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
        // Why: results can outlive the selected worktree; clicks must reuse the route that produced them.
        const runtimeSettings = { activeRuntimeEnvironmentId: runtimeEnvironmentId }
        const resultOwner = createFileSearchResultOwner(activeWorktreeId, runtimeSettings, {
          rootPath: worktreePath,
          executionHostId
        })
        const controller = new AbortController()
        searchControllerRef.current = controller
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
          const resultsQuery: FileSearchResultsQuery = {
            query: query.trim(),
            caseSensitive: activeSearchState?.caseSensitive ?? false,
            wholeWord: activeSearchState?.wholeWord ?? false,
            useRegex: activeSearchState?.useRegex ?? false
          }
          const results = await searchRuntimeFiles(
            {
              settings: runtimeSettings,
              worktreeId: activeWorktreeId,
              worktreePath,
              connectionId
            },
            {
              ...resultsQuery,
              rootPath: worktreePath,
              includePattern: activeSearchState?.includePattern || undefined,
              excludePattern: activeSearchState?.excludePattern || undefined,
              maxResults: SEARCH_MAX_RESULTS
            },
            controller.signal
          )
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({ results, resultOwner, resultsQuery })
          }
        } catch (err) {
          if (controller.signal.aborted) {
            return
          }
          console.error('Search failed:', err)
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({
              results: null,
              error:
                readIpcErrorDetail(err) ??
                translate('fileSearch.failed', 'Search failed. Try again.'),
              resultOwner
            })
          }
        } finally {
          if (searchControllerRef.current === controller) {
            searchControllerRef.current = null
          }
          if (latestSearchIdRef.current === searchId) {
            updateActiveSearchState({ loading: false })
          }
        }
      }, SEARCH_DEBOUNCE_MS)
    },
    [activeWorktreeId, updateActiveSearchState, worktreePath, executionHostId, runtimeEnvironmentId]
  )

  useEffect(
    () => cancelPendingSearch,
    [cancelPendingSearch, worktreePath, executionHostId, runtimeEnvironmentId]
  )

  return { executeSearch, cancelPendingSearch }
}

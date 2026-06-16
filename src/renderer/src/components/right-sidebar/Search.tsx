import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { getConnectionId } from '@/lib/connection-context'
import { searchRuntimeFiles } from '@/runtime/runtime-file-client'
import type { SearchFileResult, SearchMatch } from '../../../../shared/types'
import { buildSearchRows } from './search-rows'
import { cancelRevealFrame, openMatchResult } from './search-match-open'
import { SearchHeader } from './SearchHeader'
import { SearchResultsPane } from './SearchResultsPane'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'
import { translate } from '@/i18n/i18n'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MAX_RESULTS = 2000
const EMPTY_COLLAPSED_FILES = new Set<string>()

export default function Search(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const openFile = useAppStore((s) => s.openFile)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)

  const searchState = useAppStore((s) =>
    activeWorktreeId ? s.fileSearchStateByWorktree[activeWorktreeId] : null
  )
  const fileSearchQuery = searchState?.query ?? ''
  const fileSearchCaseSensitive = searchState?.caseSensitive ?? false
  const fileSearchWholeWord = searchState?.wholeWord ?? false
  const fileSearchUseRegex = searchState?.useRegex ?? false
  const fileSearchIncludePattern = searchState?.includePattern ?? ''
  const fileSearchExcludePattern = searchState?.excludePattern ?? ''
  const fileSearchResults = searchState?.results ?? null
  const fileSearchLoading = searchState?.loading ?? false
  const fileSearchCollapsedFiles = searchState?.collapsedFiles ?? EMPTY_COLLAPSED_FILES
  const fileSearchSeedRequestId = searchState?.seedRequestId
  const fileSearchFocusRequestId = searchState?.focusRequestId

  const updateFileSearchState = useAppStore((s) => s.updateFileSearchState)
  const consumeFileSearchSeedRequest = useAppStore((s) => s.consumeFileSearchSeedRequest)
  const toggleFileSearchCollapsedFile = useAppStore((s) => s.toggleFileSearchCollapsedFile)
  const clearFileSearch = useAppStore((s) => s.clearFileSearch)

  const inputRef = useRef<HTMLInputElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSearchIdRef = useRef(0)
  const resultsScrollRef = useRef<HTMLDivElement>(null)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)
  const seededInputSelectionRafRef = useRef<number | null>(null)
  const cleanupSearchPanelRef = useRef<() => void>(() => {})
  const previousCleanupSearchPanelRef = useRef<(() => void) | null>(null)
  const includeInputRef = useRef<HTMLInputElement>(null)
  const excludeInputRef = useRef<HTMLInputElement>(null)

  const updateActiveSearchState = useCallback(
    (updates: Partial<NonNullable<typeof searchState>>) => {
      if (!activeWorktreeId) {
        return
      }
      updateFileSearchState(activeWorktreeId, updates)
    },
    [activeWorktreeId, updateFileSearchState]
  )

  const clearActiveSearch = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    clearFileSearch(activeWorktreeId)
  }, [activeWorktreeId, clearFileSearch])

  const toggleActiveCollapsedFile = useCallback(
    (filePath: string) => {
      if (!activeWorktreeId) {
        return
      }
      toggleFileSearchCollapsedFile(activeWorktreeId, filePath)
    },
    [activeWorktreeId, toggleFileSearchCollapsedFile]
  )

  const cancelPendingSearch = useCallback(() => {
    latestSearchIdRef.current += 1
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    updateActiveSearchState({ loading: false })
  }, [updateActiveSearchState])

  const worktreePath = activeWorktree?.path ?? null

  const cancelSeededInputSelectionFrame = useCallback(() => {
    if (seededInputSelectionRafRef.current !== null) {
      cancelAnimationFrame(seededInputSelectionRafRef.current)
      seededInputSelectionRafRef.current = null
    }
  }, [])

  const scheduleSeededInputSelection = useCallback(() => {
    cancelSeededInputSelectionFrame()
    // Why: match VS Code's seeded file search behavior; typing should replace
    // the selected query after the sidebar finishes opening/loading.
    seededInputSelectionRafRef.current = requestAnimationFrame(() => {
      seededInputSelectionRafRef.current = null
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [cancelSeededInputSelectionFrame])

  const setSearchInputRef = useCallback((el: HTMLInputElement | null): void => {
    inputRef.current = el
    // Why: focusing belongs to the input mount; the object ref still backs
    // seeded-search selection and result keyboard handlers.
    if (el) {
      el.focus()
    }
  }, [])

  const cleanupCurrentSearchPanel = useCallback(() => {
    cancelPendingSearch()
    cancelSeededInputSelectionFrame()
    cancelRevealFrame(revealRafRef)
    cancelRevealFrame(revealInnerRafRef)
  }, [cancelPendingSearch, cancelSeededInputSelectionFrame])

  cleanupSearchPanelRef.current = cleanupCurrentSearchPanel

  useEffect(() => {
    const previousCleanup = previousCleanupSearchPanelRef.current
    previousCleanupSearchPanelRef.current = cleanupCurrentSearchPanel
    if (previousCleanup && previousCleanup !== cleanupCurrentSearchPanel) {
      previousCleanup()
    }
  }, [cleanupCurrentSearchPanel])

  const setSearchPanelRef = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) {
      return
    }
    // Why: debounce, seeded focus, and reveal frames are scoped to this panel
    // owner; clearing them from a stable root ref avoids a cleanup-only Effect.
    cleanupSearchPanelRef.current()
  }, [])

  useEffect(() => {
    if (!worktreePath) {
      cancelPendingSearch()
      updateActiveSearchState({ results: null })
    }
  }, [worktreePath, cancelPendingSearch, updateActiveSearchState])

  // Why: large search result sets can update while the user is still typing.
  // Deferring the heavy row-model update keeps the input responsive instead of
  // blocking on a full sidebar rerender.
  const deferredSearchResults = useDeferredValue(fileSearchResults)
  const searchRows = useMemo(
    () =>
      buildSearchRows(
        fileSearchQuery.trim() && worktreePath ? deferredSearchResults : null,
        fileSearchCollapsedFiles
      ),
    [deferredSearchResults, fileSearchCollapsedFiles, fileSearchQuery, worktreePath]
  )

  // Execute search with debounce — reads fresh state inside setTimeout
  // to avoid stale closures when options change during debounce
  const executeSearch = useCallback(
    (query: string) => {
      latestSearchIdRef.current += 1
      const searchId = latestSearchIdRef.current

      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }

      if (!query.trim() || !worktreePath) {
        updateActiveSearchState({ results: null, loading: false })
        return
      }

      updateActiveSearchState({ loading: true })
      searchTimerRef.current = setTimeout(async () => {
        searchTimerRef.current = null
        try {
          const state = useAppStore.getState()
          const connectionId = getConnectionId(activeWorktreeId!) ?? undefined
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
              caseSensitive:
                state.fileSearchStateByWorktree[activeWorktreeId!]?.caseSensitive ?? false,
              wholeWord: state.fileSearchStateByWorktree[activeWorktreeId!]?.wholeWord ?? false,
              useRegex: state.fileSearchStateByWorktree[activeWorktreeId!]?.useRegex ?? false,
              includePattern:
                state.fileSearchStateByWorktree[activeWorktreeId!]?.includePattern || undefined,
              excludePattern:
                state.fileSearchStateByWorktree[activeWorktreeId!]?.excludePattern || undefined,
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
    [worktreePath, updateActiveSearchState, activeWorktreeId]
  )

  useEffect(() => {
    if (!activeWorktreeId || fileSearchSeedRequestId === undefined) {
      return
    }

    // Why: Cmd/Ctrl+Shift+F can seed the query or the include pattern (Find in
    // Folder) before this lazy panel mounts. The one-shot request lets the
    // mounted panel run the real runtime search and steal focus to the input.
    if (fileSearchQuery.trim()) {
      executeSearch(fileSearchQuery)
    }
    scheduleSeededInputSelection()
    consumeFileSearchSeedRequest(activeWorktreeId, fileSearchSeedRequestId)
  }, [
    activeWorktreeId,
    consumeFileSearchSeedRequest,
    executeSearch,
    fileSearchQuery,
    fileSearchSeedRequestId,
    scheduleSeededInputSelection
  ])

  useEffect(() => {
    if (!activeWorktreeId || fileSearchFocusRequestId === undefined) {
      return
    }
    inputRef.current?.focus()
  }, [activeWorktreeId, fileSearchFocusRequestId])

  const handleClearSearch = useCallback(() => {
    cancelPendingSearch()
    clearActiveSearch()
  }, [cancelPendingSearch, clearActiveSearch])

  // Re-execute search from event handlers when options change
  const rerunSearch = useCallback(() => {
    const q = useAppStore.getState().fileSearchStateByWorktree[activeWorktreeId!]?.query ?? ''
    if (q.trim()) {
      executeSearch(q)
    }
  }, [executeSearch, activeWorktreeId])

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      updateActiveSearchState({ query: val })
      executeSearch(val)
    },
    [updateActiveSearchState, executeSearch]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (fileSearchQuery) {
          handleClearSearch()
        }
      }
      if (e.key === 'Enter') {
        executeSearch(fileSearchQuery)
      }
    },
    [fileSearchQuery, handleClearSearch, executeSearch]
  )

  const handleMatchClick = useCallback(
    (fileResult: SearchFileResult, match: SearchMatch) => {
      if (!activeWorktreeId) {
        return
      }
      openMatchResult({
        activeWorktreeId,
        fileResult,
        match,
        openFile,
        setPendingEditorReveal,
        revealRafRef,
        revealInnerRafRef
      })
    },
    [activeWorktreeId, openFile, setPendingEditorReveal]
  )

  if (!activeWorktreeId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        {translate(
          'auto.components.right.sidebar.Search.98c8435e36',
          'Select a workspace to search'
        )}
      </div>
    )
  }

  return (
    <div ref={setSearchPanelRef} className="flex flex-col h-full">
      <SearchHeader
        inputRef={setSearchInputRef}
        includeInputRef={includeInputRef}
        excludeInputRef={excludeInputRef}
        query={fileSearchQuery}
        loading={fileSearchLoading}
        caseSensitive={fileSearchCaseSensitive}
        wholeWord={fileSearchWholeWord}
        useRegex={fileSearchUseRegex}
        includePattern={fileSearchIncludePattern}
        excludePattern={fileSearchExcludePattern}
        onQueryChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        onClearSearch={handleClearSearch}
        onToggleCaseSensitive={() => {
          updateActiveSearchState({ caseSensitive: !fileSearchCaseSensitive })
          rerunSearch()
        }}
        onToggleWholeWord={() => {
          updateActiveSearchState({ wholeWord: !fileSearchWholeWord })
          rerunSearch()
        }}
        onToggleRegex={() => {
          updateActiveSearchState({ useRegex: !fileSearchUseRegex })
          rerunSearch()
        }}
        onIncludeChange={(value) => {
          updateActiveSearchState({ includePattern: value })
          rerunSearch()
        }}
        onExcludeChange={(value) => {
          updateActiveSearchState({ excludePattern: value })
          rerunSearch()
        }}
      />

      <SearchResultsPane
        results={deferredSearchResults}
        hasCommittedResults={fileSearchResults !== null}
        query={fileSearchQuery}
        loading={fileSearchLoading}
        rows={searchRows}
        scrollRef={resultsScrollRef}
        onToggleCollapsedFile={toggleActiveCollapsedFile}
        onMatchClick={handleMatchClick}
      />
    </div>
  )
}

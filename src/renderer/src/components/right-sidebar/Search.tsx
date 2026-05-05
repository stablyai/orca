import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { getConnectionId } from '@/lib/connection-context'
import type { SearchFileResult, SearchMatch } from '../../../../shared/types'
import { buildSearchRows } from './search-rows'
import { cancelRevealFrame, openMatchResult } from './search-match-open'
import { SearchHeader } from './SearchHeader'
import { FileResultRow, MatchResultRow } from './SearchResultItems'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MAX_RESULTS = 2000
const SEARCH_VIRTUAL_OVERSCAN = 12
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

  const updateFileSearchState = useAppStore((s) => s.updateFileSearchState)
  const toggleFileSearchCollapsedFile = useAppStore((s) => s.toggleFileSearchCollapsedFile)
  const clearFileSearch = useAppStore((s) => s.clearFileSearch)

  const inputRef = useRef<HTMLInputElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSearchIdRef = useRef(0)
  const resultsScrollRef = useRef<HTMLDivElement>(null)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)
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

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      cancelPendingSearch()
      cancelRevealFrame(revealRafRef)
      cancelRevealFrame(revealInnerRafRef)
    }
  }, [cancelPendingSearch])

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

  const virtualizer = useVirtualizer({
    count: searchRows.length,
    getScrollElement: () => resultsScrollRef.current,
    estimateSize: (index) => {
      const row = searchRows[index]
      if (!row) {
        return 20
      }
      // Why: file rows include pt-1.5 (6 px) for inter-group spacing, so
      // their estimate is taller than match rows.
      if (row.type === 'file') {
        return 28
      }
      return 20
    },
    // Why: paddingEnd adds visible breathing room after the last result row.
    // paddingStart is unnecessary because each file row already includes
    // pt-1.5 for inter-group spacing (which also covers the first row).
    paddingEnd: 8,
    overscan: SEARCH_VIRTUAL_OVERSCAN,
    getItemKey: (index) => {
      const row = searchRows[index]
      if (!row) {
        return `missing:${index}`
      }
      if (row.type === 'file') {
        return `file:${row.fileResult.filePath}`
      }
      return `match:${row.fileResult.filePath}:${row.match.line}:${row.match.column}:${row.matchIndex}`
    }
  })

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
          const results = await window.api.fs.search({
            query: query.trim(),
            rootPath: worktreePath,
            connectionId,
            caseSensitive:
              state.fileSearchStateByWorktree[activeWorktreeId!]?.caseSensitive ?? false,
            wholeWord: state.fileSearchStateByWorktree[activeWorktreeId!]?.wholeWord ?? false,
            useRegex: state.fileSearchStateByWorktree[activeWorktreeId!]?.useRegex ?? false,
            includePattern:
              state.fileSearchStateByWorktree[activeWorktreeId!]?.includePattern || undefined,
            excludePattern:
              state.fileSearchStateByWorktree[activeWorktreeId!]?.excludePattern || undefined,
            maxResults: SEARCH_MAX_RESULTS
          })
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
        Select a worktree to search
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <SearchHeader
        inputRef={inputRef}
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

      {/* Why: the summary is rendered outside the virtualizer so it stays
         pinned at the top while the user scrolls through results. */}
      {deferredSearchResults && searchRows.length > 0 && (
        <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border">
          {deferredSearchResults.totalMatches} result
          {deferredSearchResults.totalMatches !== 1 ? 's' : ''} in{' '}
          {deferredSearchResults.files.length} file
          {deferredSearchResults.files.length !== 1 ? 's' : ''}
          {deferredSearchResults.truncated && ' (results truncated)'}
        </div>
      )}

      <div ref={resultsScrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-sleek">
        {searchRows.length > 0 && (
          <div
            className="relative w-full"
            style={{
              height: virtualizer.getTotalSize()
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = searchRows[virtualRow.index]
              if (!row) {
                return null
              }

              return (
                <div
                  key={virtualRow.key}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {row.type === 'file' && (
                    <FileResultRow
                      fileResult={row.fileResult}
                      collapsed={row.collapsed}
                      onToggleCollapse={() => toggleActiveCollapsedFile(row.fileResult.filePath)}
                    />
                  )}
                  {row.type === 'match' && (
                    <MatchResultRow
                      match={row.match}
                      relativePath={row.fileResult.relativePath}
                      onClick={() => handleMatchClick(row.fileResult, row.match)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {!fileSearchResults && fileSearchQuery && !fileSearchLoading && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            Press Enter to search
          </div>
        )}

        {!fileSearchQuery && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            Type to search in files
          </div>
        )}
      </div>
    </div>
  )
}

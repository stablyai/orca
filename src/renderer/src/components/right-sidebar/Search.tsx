import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Search as SearchIcon,
  CaseSensitive,
  WholeWord,
  Regex,
  ChevronRight,
  X,
  ChevronDown,
  Loader2
} from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import type { SearchFileResult, SearchMatch } from '../../../../shared/types'
import { buildSearchRows } from './search-rows'
import { cancelRevealFrame, openMatchResult } from './search-match-open'
import { ToggleButton, FileResultRow, MatchResultRow } from './SearchResultItems'

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MAX_RESULTS = 2000
const SEARCH_VIRTUAL_OVERSCAN = 12

export default function Search(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const openFile = useAppStore((s) => s.openFile)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)

  const fileSearchQuery = useAppStore((s) => s.fileSearchQuery)
  const fileSearchCaseSensitive = useAppStore((s) => s.fileSearchCaseSensitive)
  const fileSearchWholeWord = useAppStore((s) => s.fileSearchWholeWord)
  const fileSearchUseRegex = useAppStore((s) => s.fileSearchUseRegex)
  const fileSearchIncludePattern = useAppStore((s) => s.fileSearchIncludePattern)
  const fileSearchExcludePattern = useAppStore((s) => s.fileSearchExcludePattern)
  const fileSearchResults = useAppStore((s) => s.fileSearchResults)
  const fileSearchLoading = useAppStore((s) => s.fileSearchLoading)
  const fileSearchCollapsedFiles = useAppStore((s) => s.fileSearchCollapsedFiles)

  const setFileSearchQuery = useAppStore((s) => s.setFileSearchQuery)
  const setFileSearchCaseSensitive = useAppStore((s) => s.setFileSearchCaseSensitive)
  const setFileSearchWholeWord = useAppStore((s) => s.setFileSearchWholeWord)
  const setFileSearchUseRegex = useAppStore((s) => s.setFileSearchUseRegex)
  const setFileSearchIncludePattern = useAppStore((s) => s.setFileSearchIncludePattern)
  const setFileSearchExcludePattern = useAppStore((s) => s.setFileSearchExcludePattern)
  const setFileSearchResults = useAppStore((s) => s.setFileSearchResults)
  const setFileSearchLoading = useAppStore((s) => s.setFileSearchLoading)
  const toggleFileSearchCollapsedFile = useAppStore((s) => s.toggleFileSearchCollapsedFile)
  const clearFileSearch = useAppStore((s) => s.clearFileSearch)

  const inputRef = useRef<HTMLInputElement>(null)
  const [showFilters, setShowFilters] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSearchIdRef = useRef(0)
  const resultsScrollRef = useRef<HTMLDivElement>(null)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)

  const cancelPendingSearch = useCallback(() => {
    latestSearchIdRef.current += 1
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    setFileSearchLoading(false)
  }, [setFileSearchLoading])

  // Find active worktree path
  const worktreePath = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

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
      setFileSearchResults(null)
    }
  }, [worktreePath, cancelPendingSearch, setFileSearchResults])

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
        return 24
      }
      if (row.type === 'summary') {
        return 24
      }
      if (row.type === 'file') {
        return 26
      }
      return 22
    },
    overscan: SEARCH_VIRTUAL_OVERSCAN,
    getItemKey: (index) => {
      const row = searchRows[index]
      if (!row) {
        return `missing:${index}`
      }
      if (row.type === 'summary') {
        return 'summary'
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
        setFileSearchResults(null)
        setFileSearchLoading(false)
        return
      }

      setFileSearchLoading(true)
      searchTimerRef.current = setTimeout(async () => {
        searchTimerRef.current = null
        try {
          const state = useAppStore.getState()
          const results = await window.api.fs.search({
            query: query.trim(),
            rootPath: worktreePath,
            caseSensitive: state.fileSearchCaseSensitive,
            wholeWord: state.fileSearchWholeWord,
            useRegex: state.fileSearchUseRegex,
            includePattern: state.fileSearchIncludePattern || undefined,
            excludePattern: state.fileSearchExcludePattern || undefined,
            maxResults: SEARCH_MAX_RESULTS
          })
          if (latestSearchIdRef.current === searchId) {
            setFileSearchResults(results)
          }
        } catch (err) {
          console.error('Search failed:', err)
          if (latestSearchIdRef.current === searchId) {
            setFileSearchResults({ files: [], totalMatches: 0, truncated: false })
          }
        } finally {
          if (latestSearchIdRef.current === searchId) {
            setFileSearchLoading(false)
          }
        }
      }, SEARCH_DEBOUNCE_MS)
    },
    [worktreePath, setFileSearchResults, setFileSearchLoading]
  )

  const handleClearSearch = useCallback(() => {
    cancelPendingSearch()
    clearFileSearch()
  }, [cancelPendingSearch, clearFileSearch])

  // Re-execute search from event handlers when options change
  const rerunSearch = useCallback(() => {
    const q = useAppStore.getState().fileSearchQuery
    if (q.trim()) {
      executeSearch(q)
    }
  }, [executeSearch])

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      setFileSearchQuery(val)
      executeSearch(val)
    },
    [setFileSearchQuery, executeSearch]
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
      {/* Search input area */}
      <div className="flex flex-col gap-1.5 p-2 border-b border-border">
        {/* Main search row */}
        <div className="flex items-center gap-1 bg-input/50 border border-border rounded-sm px-1.5 focus-within:border-ring">
          <SearchIcon size={14} className="text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent text-xs py-1.5 outline-none text-foreground placeholder:text-muted-foreground min-w-0"
            placeholder="Search"
            value={fileSearchQuery}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
          {fileSearchLoading && (
            <Loader2 size={12} className="text-muted-foreground animate-spin flex-shrink-0" />
          )}
          {fileSearchQuery && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="h-auto w-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              onClick={handleClearSearch}
            >
              <X size={12} />
            </Button>
          )}
          {/* Toggle buttons */}
          <ToggleButton
            active={fileSearchCaseSensitive}
            onClick={() => {
              setFileSearchCaseSensitive(!fileSearchCaseSensitive)
              rerunSearch()
            }}
            title="Match Case"
          >
            <CaseSensitive size={14} />
          </ToggleButton>
          <ToggleButton
            active={fileSearchWholeWord}
            onClick={() => {
              setFileSearchWholeWord(!fileSearchWholeWord)
              rerunSearch()
            }}
            title="Match Whole Word"
          >
            <WholeWord size={14} />
          </ToggleButton>
          <ToggleButton
            active={fileSearchUseRegex}
            onClick={() => {
              setFileSearchUseRegex(!fileSearchUseRegex)
              rerunSearch()
            }}
            title="Use Regular Expression"
          >
            <Regex size={14} />
          </ToggleButton>
        </div>

        {/* Files to include/exclude toggle */}
        <Button
          type="button"
          variant="ghost"
          className="h-auto justify-start gap-1 self-start px-0 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setShowFilters(!showFilters)}
        >
          {showFilters ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span>files to include/exclude</span>
        </Button>

        {showFilters && (
          <div className="flex flex-col gap-1">
            <input
              type="text"
              className="bg-input/50 border border-border rounded-sm px-2 py-1 text-xs outline-none focus:border-ring text-foreground placeholder:text-muted-foreground"
              placeholder="files to include (e.g. *.ts, src/**)"
              value={fileSearchIncludePattern}
              onChange={(e) => {
                setFileSearchIncludePattern(e.target.value)
                rerunSearch()
              }}
              spellCheck={false}
            />
            <input
              type="text"
              className="bg-input/50 border border-border rounded-sm px-2 py-1 text-xs outline-none focus:border-ring text-foreground placeholder:text-muted-foreground"
              placeholder="files to exclude (e.g. *.min.js, dist/**)"
              value={fileSearchExcludePattern}
              onChange={(e) => {
                setFileSearchExcludePattern(e.target.value)
                rerunSearch()
              }}
              spellCheck={false}
            />
          </div>
        )}
      </div>

      {/* Results area */}
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
                  {row.type === 'summary' && (
                    <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border">
                      {row.totalMatches} result{row.totalMatches !== 1 ? 's' : ''} in{' '}
                      {row.fileCount} file{row.fileCount !== 1 ? 's' : ''}
                      {row.truncated && ' (results truncated)'}
                    </div>
                  )}
                  {row.type === 'file' && (
                    <FileResultRow
                      fileResult={row.fileResult}
                      collapsed={row.collapsed}
                      onToggleCollapse={() =>
                        toggleFileSearchCollapsedFile(row.fileResult.filePath)
                      }
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

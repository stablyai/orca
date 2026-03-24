import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { detectLanguage } from '@/lib/language-detect'
import type { SearchFileResult, SearchMatch } from '../../../../shared/types'
import { ToggleButton, FileResultItem } from './SearchResultItems'

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
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
    }
  }, [])

  // Execute search with debounce — reads fresh state inside setTimeout
  // to avoid stale closures when options change during debounce
  const executeSearch = useCallback(
    (query: string) => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }

      if (!query.trim() || !worktreePath) {
        setFileSearchResults(null)
        setFileSearchLoading(false)
        return
      }

      setFileSearchLoading(true)
      searchTimerRef.current = setTimeout(async () => {
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
            maxResults: 10000
          })
          setFileSearchResults(results)
        } catch (err) {
          console.error('Search failed:', err)
          setFileSearchResults({ files: [], totalMatches: 0, truncated: false })
        } finally {
          setFileSearchLoading(false)
        }
      }, 300)
    },
    [worktreePath, setFileSearchResults, setFileSearchLoading]
  )

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
          clearFileSearch()
        }
      }
      if (e.key === 'Enter') {
        executeSearch(fileSearchQuery)
      }
    },
    [fileSearchQuery, clearFileSearch, executeSearch]
  )

  const handleMatchClick = useCallback(
    (fileResult: SearchFileResult, match: SearchMatch) => {
      if (!activeWorktreeId) {
        return
      }

      // Set pending navigation so editor scrolls to the match
      setPendingEditorReveal({
        line: match.line,
        column: match.column,
        matchLength: match.matchLength
      })

      openFile({
        filePath: fileResult.filePath,
        relativePath: fileResult.relativePath,
        worktreeId: activeWorktreeId,
        language: detectLanguage(fileResult.relativePath),
        mode: 'edit'
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
            <button
              className="p-0.5 rounded-sm hover:bg-muted text-muted-foreground hover:text-foreground"
              onClick={clearFileSearch}
            >
              <X size={12} />
            </button>
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
        <button
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setShowFilters(!showFilters)}
        >
          {showFilters ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span>files to include/exclude</span>
        </button>

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
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-sleek">
        {fileSearchResults && (
          <>
            {/* Results summary */}
            <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border">
              {fileSearchResults.totalMatches} result
              {fileSearchResults.totalMatches !== 1 ? 's' : ''} in {fileSearchResults.files.length}{' '}
              file{fileSearchResults.files.length !== 1 ? 's' : ''}
              {fileSearchResults.truncated && ' (results truncated)'}
            </div>

            {/* File results */}
            {fileSearchResults.files.map((fileResult) => (
              <FileResultItem
                key={fileResult.filePath}
                fileResult={fileResult}
                collapsed={fileSearchCollapsedFiles.has(fileResult.filePath)}
                onToggleCollapse={() => toggleFileSearchCollapsedFile(fileResult.filePath)}
                onMatchClick={(match) => handleMatchClick(fileResult, match)}
              />
            ))}
          </>
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

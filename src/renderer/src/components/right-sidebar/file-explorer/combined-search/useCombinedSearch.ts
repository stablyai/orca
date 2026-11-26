import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import type {
  SearchFileResult,
  SearchMatch
} from '../../../../../../shared/file-search/code-search-types'
import { buildSearchRows } from '../content-search/search-rows'
import { cancelRevealFrame, openMatchResult } from '../content-search/search-match-open'
import type { SearchFiltersProps } from '../content-search/SearchFilters'
import { isTextSearchQuery, useFileSearchRunner } from '../content-search/useFileSearchRunner'
import { useFileSearchScope } from '../content-search/useFileSearchScope'
import {
  COMBINED_SEARCH_LISTBOX_ID,
  createCombinedSearchRows,
  getCombinedSearchOptionId,
  type CombinedSearchRow
} from './combined-search-rows'
import type { CombinedSearchFieldState, CombinedSearchResultsState } from './combined-search-types'
import { useCombinedSearchNavigation } from './use-combined-search-navigation'
import { useCombinedSearchSeed } from './use-combined-search-seed'
import { useSearchDraftLifecycle } from './use-search-draft-lifecycle'
import type { NameMatch, NameMatchResults } from './name-match-results'

const EMPTY_COLLAPSED_FILES = new Set<string>()

/** Drives one query into the name rows (immediate) and the text search (debounced), with shared keyboard navigation. */
export function useCombinedSearch({
  activeWorktreeId,
  worktreePath,
  query,
  setQuery,
  nameMatches,
  namesLoading,
  namesError,
  onOpenName,
  onShowAllNames
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
  query: string
  setQuery: (query: string) => void
  nameMatches: NameMatchResults | null
  namesLoading: boolean
  namesError: string | null
  onOpenName: (match: NameMatch, permanent: boolean) => void
  onShowAllNames: () => void
}): {
  clearQuery: () => void
  field: CombinedSearchFieldState
  filters: SearchFiltersProps
  results: CombinedSearchResultsState
} {
  const openFile = useAppStore((s) => s.openFile)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const searchState = useAppStore((s) =>
    activeWorktreeId ? s.fileSearchStateByWorktree[activeWorktreeId] : null
  )
  const committedQuery = searchState?.query ?? ''
  const caseSensitive = searchState?.caseSensitive ?? false
  const wholeWord = searchState?.wholeWord ?? false
  const useRegex = searchState?.useRegex ?? false
  const includePattern = searchState?.includePattern ?? ''
  const excludePattern = searchState?.excludePattern ?? ''
  const storedResults = searchState?.results ?? null
  const storedResultOwner = searchState?.resultOwner ?? null
  const textLoading = searchState?.loading ?? false
  const collapsedFiles = searchState?.collapsedFiles ?? EMPTY_COLLAPSED_FILES
  const seedRequestId = searchState?.seedRequestId
  const focusRequestId = searchState?.focusRequestId

  const updateFileSearchState = useAppStore((s) => s.updateFileSearchState)
  const toggleFileSearchCollapsedFile = useAppStore((s) => s.toggleFileSearchCollapsedFile)
  const clearFileSearch = useAppStore((s) => s.clearFileSearch)

  const inputRef = useRef<HTMLInputElement>(null)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)
  const includeInputRef = useRef<HTMLInputElement>(null)
  const excludeInputRef = useRef<HTMLInputElement>(null)

  const updateActiveSearchState = useCallback(
    (updates: Partial<NonNullable<typeof searchState>>) => {
      if (activeWorktreeId) {
        updateFileSearchState(activeWorktreeId, updates)
      }
    },
    [activeWorktreeId, updateFileSearchState]
  )

  const { executeSearch, cancelPendingSearch } = useFileSearchRunner({
    activeWorktreeId,
    worktreePath,
    updateActiveSearchState
  })
  // An explicit seed may search one character; typing never does.
  const [forcedShortQuery, setForcedShortQuery] = useState<string | null>(null)
  const runTextSearch = useCallback(
    (value: string) => executeSearch(value, { allowShortQuery: value === forcedShortQuery }),
    [executeSearch, forcedShortQuery]
  )
  const isCurrentOwner = useFileSearchScope({
    activeWorktreeId,
    worktreePath,
    cancelPendingSearch,
    updateActiveSearchState
  })

  useEffect(() => {
    return () => {
      cancelRevealFrame(revealRafRef)
      cancelRevealFrame(revealInnerRafRef)
    }
  }, [])

  const textQueryActive =
    isTextSearchQuery(query) || (forcedShortQuery === query && query.trim().length > 0)
  // Only results committed for the live draft are shown or activated, never a previous query's.
  const resultsAreCurrent =
    textQueryActive && committedQuery === query && isCurrentOwner(storedResultOwner)
  const committedResults = useMemo(
    () => ({
      results: resultsAreCurrent ? storedResults : null,
      owner: resultsAreCurrent ? storedResultOwner : null
    }),
    [resultsAreCurrent, storedResultOwner, storedResults]
  )
  // Large result sets render at lower priority so the field and name rows stay responsive.
  const deferredResults = useDeferredValue(committedResults)
  const textRows = useMemo(
    () => buildSearchRows(deferredResults.results, collapsedFiles),
    [collapsedFiles, deferredResults.results]
  )
  const textError = resultsAreCurrent ? (searchState?.error ?? null) : null
  const hasQuery = query.trim().length > 0
  const textPending = textQueryActive && (committedQuery !== query || textLoading)

  const model = useMemo(
    () =>
      createCombinedSearchRows({
        names: nameMatches,
        textResult: textQueryActive ? deferredResults.results : null,
        textRows,
        textPending,
        namesError: hasQuery ? namesError : null,
        textError
      }),
    [
      deferredResults.results,
      hasQuery,
      nameMatches,
      namesError,
      textError,
      textPending,
      textQueryActive,
      textRows
    ]
  )

  const clearQuery = useCallback(() => {
    setQuery('')
    setForcedShortQuery(null)
    cancelPendingSearch()
    if (activeWorktreeId) {
      clearFileSearch(activeWorktreeId)
    }
  }, [activeWorktreeId, cancelPendingSearch, clearFileSearch, setQuery])

  const handleQueryChange = useCallback(
    (value: string) => {
      if (!value.trim()) {
        clearQuery()
        setQuery(value)
        return
      }
      setQuery(value)
      runTextSearch(value)
    },
    [clearQuery, runTextSearch, setQuery]
  )

  const rerunTextSearch = useCallback(() => {
    if (query.trim()) {
      runTextSearch(query)
    }
  }, [query, runTextSearch])

  const openMatch = useCallback(
    (fileResult: SearchFileResult, match: SearchMatch) => {
      if (!isCurrentOwner(deferredResults.owner)) {
        return
      }
      openMatchResult({
        resultOwner: deferredResults.owner,
        fileResult,
        match,
        openFile,
        setPendingEditorReveal,
        revealRafRef,
        revealInnerRafRef
      })
    },
    [deferredResults.owner, isCurrentOwner, openFile, setPendingEditorReveal]
  )

  const openRow = useCallback(
    (row: CombinedSearchRow, permanent: boolean) => {
      if (row.type === 'name') {
        onOpenName(row.match, permanent)
      } else if (row.type === 'show-all') {
        onShowAllNames()
      } else if (row.type === 'file') {
        if (activeWorktreeId) {
          toggleFileSearchCollapsedFile(activeWorktreeId, row.fileResult.filePath)
        }
      } else if (row.type === 'match') {
        openMatch(row.fileResult, row.match)
      }
    },
    [activeWorktreeId, onOpenName, onShowAllNames, openMatch, toggleFileSearchCollapsedFile]
  )
  const { activeIndex, activateRow, handleKeyDown } = useCombinedSearchNavigation({
    query,
    model,
    inputRef,
    clearQuery,
    openRow
  })

  const applySeededQuery = useCallback(
    (seeded: string) => {
      setQuery(seeded)
      setForcedShortQuery(seeded)
      executeSearch(seeded, { allowShortQuery: true })
    },
    [executeSearch, setQuery]
  )
  useCombinedSearchSeed({
    activeWorktreeId,
    seedRequestId,
    focusRequestId,
    query,
    inputRef,
    applySeededQuery,
    rerunDraft: runTextSearch
  })
  useSearchDraftLifecycle({ activeWorktreeId, query, updateActiveSearchState, runTextSearch })

  return {
    clearQuery,
    field: {
      inputRef,
      query,
      loading: hasQuery && (namesLoading || textPending),
      caseSensitive,
      wholeWord,
      useRegex,
      activeDescendantId:
        hasQuery && activeIndex !== -1 ? getCombinedSearchOptionId(activeIndex) : undefined,
      onQueryChange: handleQueryChange,
      onKeyDown: handleKeyDown,
      onClear: clearQuery,
      onToggleCaseSensitive: () => {
        updateActiveSearchState({ caseSensitive: !caseSensitive })
        rerunTextSearch()
      },
      onToggleWholeWord: () => {
        updateActiveSearchState({ wholeWord: !wholeWord })
        rerunTextSearch()
      },
      onToggleRegex: () => {
        updateActiveSearchState({ useRegex: !useRegex })
        rerunTextSearch()
      }
    },
    filters: {
      includePattern,
      excludePattern,
      includeInputRef,
      excludeInputRef,
      onIncludeChange: (value: string) => {
        updateActiveSearchState({ includePattern: value })
        rerunTextSearch()
      },
      onExcludeChange: (value: string) => {
        updateActiveSearchState({ excludePattern: value })
        rerunTextSearch()
      }
    },
    results: {
      model,
      activeIndex,
      listboxId: COMBINED_SEARCH_LISTBOX_ID,
      onActivateRow: activateRow
    }
  }
}

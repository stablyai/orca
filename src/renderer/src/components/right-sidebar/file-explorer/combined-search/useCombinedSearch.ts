import type React from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import type { SearchFiltersProps } from '../content-search/SearchFilters'
import { useFileSearchRunner } from '../content-search/useFileSearchRunner'
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
import { useSearchDraftLifecycle, type InitialSearchDraft } from './use-search-draft-lifecycle'
import { useCombinedTextResults } from './use-combined-text-results'
import { useNamesFirstTextSearch } from './use-names-first-text-search'
import { useOpenSearchMatch } from './use-open-search-match'
import type { NameMatch, NameMatchResults } from './name-match-results'

const EMPTY_COLLAPSED_FILES = new Set<string>()
// Results computed under the previous options must not stay clickable while the rerun debounces.
const STALE_RESULTS = { results: null, resultOwner: null, error: null } as const

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
  onShowAllNames,
  initial
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
  initial: InitialSearchDraft
}): {
  clearQuery: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Text for the pane's persistent polite live region (a muted notice, else empty). */
  announcement: string
  field: CombinedSearchFieldState
  filters: SearchFiltersProps
  results: CombinedSearchResultsState
} {
  const searchState = useAppStore((s) =>
    activeWorktreeId ? s.fileSearchStateByWorktree[activeWorktreeId] : null
  )
  const caseSensitive = searchState?.caseSensitive ?? false
  const wholeWord = searchState?.wholeWord ?? false
  const useRegex = searchState?.useRegex ?? false
  const includePattern = searchState?.includePattern ?? ''
  const excludePattern = searchState?.excludePattern ?? ''
  const collapsedFiles = searchState?.collapsedFiles ?? EMPTY_COLLAPSED_FILES
  const seedRequestId = searchState?.seedRequestId
  const focusRequestId = searchState?.focusRequestId

  const updateFileSearchState = useAppStore((s) => s.updateFileSearchState)
  const toggleFileSearchCollapsedFile = useAppStore((s) => s.toggleFileSearchCollapsedFile)
  const clearFileSearch = useAppStore((s) => s.clearFileSearch)

  const inputRef = useRef<HTMLInputElement>(null)
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

  const { executeSearch, cancelPendingSearch, stopSearch } = useFileSearchRunner({
    activeWorktreeId,
    worktreePath,
    updateActiveSearchState
  })
  const { requestTextSearch, cancelTextSearch } = useNamesFirstTextSearch({
    namesSettled: !namesLoading,
    executeSearch,
    stopSearch,
    cancelPendingSearch
  })
  // An explicit seed may search one character; typing never does.
  const [forcedShortQuery, setForcedShortQuery] = useState<string | null>(() =>
    initial.allowShort ? initial.text : null
  )
  const runTextSearch = useCallback(
    (value: string) => requestTextSearch(value, { allowShortQuery: value === forcedShortQuery }),
    [requestTextSearch, forcedShortQuery]
  )
  const isCurrentOwner = useFileSearchScope({
    activeWorktreeId,
    worktreePath,
    cancelPendingSearch: cancelTextSearch,
    updateActiveSearchState
  })

  const { deferredResults, deferredIsLive, textRows, textError, textNotice, textPending } =
    useCombinedTextResults({
      query,
      forcedShortQuery,
      searchState,
      collapsedFiles,
      isCurrentOwner
    })
  const hasQuery = query.trim().length > 0
  // The notice holds while each pause's rerun is pending; dropping it then would re-announce it on
  // every keystroke. A scan that settles without it clears it. A remount (workspace or owner change)
  // starts fresh.
  const [sessionNotice, setSessionNotice] = useState('')
  const nextSessionNotice = hasQuery ? (textNotice ?? (textPending ? sessionNotice : '')) : ''
  if (nextSessionNotice !== sessionNotice) {
    setSessionNotice(nextSessionNotice)
  }

  const model = useMemo(
    () =>
      createCombinedSearchRows({
        names: nameMatches,
        // Gate the deferred payload on the live generation so a cleared or replaced result never lingers a frame.
        textResult: deferredIsLive ? deferredResults.results : null,
        textRows,
        textPending,
        namesError: hasQuery ? namesError : null,
        textError,
        textNotice
      }),
    [
      deferredResults.results,
      hasQuery,
      nameMatches,
      namesError,
      textError,
      textNotice,
      textPending,
      deferredIsLive,
      textRows
    ]
  )

  const clearQuery = useCallback(() => {
    setQuery('')
    setForcedShortQuery(null)
    cancelTextSearch()
    if (activeWorktreeId) {
      clearFileSearch(activeWorktreeId)
    }
  }, [activeWorktreeId, cancelTextSearch, clearFileSearch, setQuery])

  // The latest draft for activation guards that run after the render that built the rows.
  const liveQueryRef = useRef(query)
  useLayoutEffect(() => {
    liveQueryRef.current = query
  })

  const handleQueryChange = useCallback(
    (value: string) => {
      // A seeded short query is admitted once; retyping it later is ordinary typing.
      if (forcedShortQuery !== null && value !== forcedShortQuery) {
        setForcedShortQuery(null)
      }
      if (!value.trim()) {
        clearQuery()
        setQuery(value)
        return
      }
      setQuery(value)
      runTextSearch(value)
    },
    [clearQuery, forcedShortQuery, runTextSearch, setQuery]
  )

  const rerunTextSearch = useCallback(() => {
    if (query.trim()) {
      runTextSearch(query)
    }
  }, [query, runTextSearch])

  const openMatch = useOpenSearchMatch({
    resultOwner: deferredResults.owner,
    resultQuery: deferredResults.query,
    liveQueryRef,
    isCurrentOwner
  })

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
      requestTextSearch(seeded, { allowShortQuery: true })
    },
    [requestTextSearch, setQuery]
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
  useSearchDraftLifecycle({
    activeWorktreeId,
    query,
    allowShortQuery: forcedShortQuery === query,
    initial,
    updateActiveSearchState,
    runTextSearch
  })

  return {
    clearQuery,
    inputRef,
    announcement: nextSessionNotice,
    field: {
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
        updateActiveSearchState({ caseSensitive: !caseSensitive, ...STALE_RESULTS })
        rerunTextSearch()
      },
      onToggleWholeWord: () => {
        updateActiveSearchState({ wholeWord: !wholeWord, ...STALE_RESULTS })
        rerunTextSearch()
      },
      onToggleRegex: () => {
        updateActiveSearchState({ useRegex: !useRegex, ...STALE_RESULTS })
        rerunTextSearch()
      }
    },
    filters: {
      includePattern,
      excludePattern,
      includeInputRef,
      excludeInputRef,
      onIncludeChange: (value: string) => {
        updateActiveSearchState({ includePattern: value, ...STALE_RESULTS })
        rerunTextSearch()
      },
      onExcludeChange: (value: string) => {
        updateActiveSearchState({ excludePattern: value, ...STALE_RESULTS })
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

import { useDeferredValue, useEffect, useMemo, useRef } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { resolveAutomationListSearchQuery } from './automation-list-search'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  buildAutomationListSearchRowFingerprint,
  buildAutomationListSearchRows,
  buildAutomationSearchRowSources,
  buildExternalAutomationSearchRowSources,
  matchAutomationListSearchRowKeys,
  type AutomationListSearchRow,
  type AutomationListSearchRowSource,
  type AutomationWorkspaceNameLookup
} from './automation-list-search-rows'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'

/** Counts the empty-state view consumes, so it never recomputes what search already knows. */
export type AutomationListSearchCounts = {
  hostRowCount: number
  visibleRowCount: number
  searchActive: boolean
}

/**
 * Rebuilds indexes only when the fingerprint changes, so a refresh tick that
 * replaces arrays with equal search content re-renders without re-indexing.
 * The cache is keyed by fingerprint rather than array identity, which useMemo
 * cannot express on its own.
 */
function useAutomationSearchRows(
  sources: AutomationListSearchRowSource[]
): AutomationListSearchRow[] {
  const fingerprint = useMemo(() => buildAutomationListSearchRowFingerprint(sources), [sources])
  const cacheRef = useRef<{ fingerprint: string; rows: AutomationListSearchRow[] } | null>(null)
  if (!cacheRef.current || cacheRef.current.fingerprint !== fingerprint) {
    cacheRef.current = { fingerprint, rows: buildAutomationListSearchRows(sources) }
  }
  return cacheRef.current.rows
}

export function useAutomationListSearch({
  listSearchQuery,
  rows,
  externalAutomationEntries,
  repoMap,
  worktreeMap,
  selectedRowKey,
  selectedExternalKey,
  selectAutomationRow,
  selectExternalKey
}: {
  listSearchQuery: string
  rows: readonly AutomationListRow[]
  externalAutomationEntries: readonly ExternalAutomationListEntry[]
  repoMap: ReadonlyMap<string, Repo>
  worktreeMap?: AutomationWorkspaceNameLookup
  /** The row currently on screen, not the bare id: two hosts can hold that id. */
  selectedRowKey: string | null
  selectedExternalKey: string | null
  selectAutomationRow: (rowKey: string | null) => void
  selectExternalKey: (externalKey: string | null) => void
}): {
  isListSearchQueryTooLarge: boolean
  filteredRows: readonly AutomationListRow[]
  filteredExternalAutomationEntries: readonly ExternalAutomationListEntry[]
  hasListItems: boolean
  hasFilteredListItems: boolean
  searchCounts: AutomationListSearchCounts
} {
  // Why: keep the input snappy; matching is deferred so caret never waits on
  // index scans. Only the normalized active query can fire a search.
  const deferredListSearchQuery = useDeferredValue(listSearchQuery)
  const liveListSearchResolution = useMemo(
    () => resolveAutomationListSearchQuery(listSearchQuery),
    [listSearchQuery]
  )
  const deferredListSearchResolution = useMemo(
    () => resolveAutomationListSearchQuery(deferredListSearchQuery),
    [deferredListSearchQuery]
  )
  // Why: field feedback tracks the live value so a huge paste is labeled
  // immediately; list filtering stays on the deferred resolution.
  const isListSearchQueryTooLarge = liveListSearchResolution.status === 'too_large'
  // Why: null means search must not run (empty, whitespace, or too large).
  const activeListSearchQuery =
    deferredListSearchResolution.status === 'active' ? deferredListSearchResolution.query : null
  const isListSearchActive = activeListSearchQuery !== null

  const automationSearchSources = useMemo(
    () => buildAutomationSearchRowSources(rows, { repoMap, worktreeMap }),
    [rows, repoMap, worktreeMap]
  )
  const automationSearchRows = useAutomationSearchRows(automationSearchSources)

  const externalAutomationSearchSources = useMemo(
    () => buildExternalAutomationSearchRowSources(externalAutomationEntries),
    [externalAutomationEntries]
  )
  const externalAutomationSearchRows = useAutomationSearchRows(externalAutomationSearchSources)

  // Why: matching runs only when the normalized query or search content changes —
  // never on relativeNow / nextRunAt / usage refresh alone.
  const filteredRowKeys = useMemo(
    (): readonly string[] | null =>
      activeListSearchQuery === null
        ? null
        : matchAutomationListSearchRowKeys(automationSearchRows, activeListSearchQuery),
    [activeListSearchQuery, automationSearchRows]
  )

  const filteredExternalAutomationKeys = useMemo(
    (): readonly string[] | null =>
      activeListSearchQuery === null
        ? null
        : matchAutomationListSearchRowKeys(externalAutomationSearchRows, activeListSearchQuery),
    [activeListSearchQuery, externalAutomationSearchRows]
  )

  const filteredRows = useMemo((): readonly AutomationListRow[] => {
    if (filteredRowKeys === null) {
      return rows
    }
    if (filteredRowKeys.length === 0) {
      return []
    }
    // Keyed by row, not automation id: a bare-id map holds one entry for two
    // hosts' copies, so one host's row would be dropped and the other doubled.
    const byKey = new Map(rows.map((row) => [row.key, row]))
    const next: AutomationListRow[] = []
    for (const key of filteredRowKeys) {
      const row = byKey.get(key)
      if (row) {
        next.push(row)
      }
    }
    return next
  }, [rows, filteredRowKeys])

  const filteredExternalAutomationEntries = useMemo((): readonly ExternalAutomationListEntry[] => {
    if (filteredExternalAutomationKeys === null) {
      return externalAutomationEntries
    }
    if (filteredExternalAutomationKeys.length === 0) {
      return []
    }
    const byKey = new Map(externalAutomationEntries.map((entry) => [entry.key, entry]))
    const next: ExternalAutomationListEntry[] = []
    for (const key of filteredExternalAutomationKeys) {
      const entry = byKey.get(key)
      if (entry) {
        next.push(entry)
      }
    }
    return next
  }, [externalAutomationEntries, filteredExternalAutomationKeys])

  const hostRowCount = rows.length + externalAutomationEntries.length
  const visibleRowCount = filteredRows.length + filteredExternalAutomationEntries.length

  // Why: when search hides the current row, move selection to the first visible
  // match so list highlight and detail stay aligned. No matches → keep detail.
  useEffect(() => {
    if (activeListSearchQuery === null) {
      return
    }
    const localVisible =
      selectedExternalKey === null &&
      selectedRowKey != null &&
      filteredRows.some((row) => row.key === selectedRowKey)
    const externalVisible =
      selectedExternalKey != null &&
      filteredExternalAutomationEntries.some((entry) => entry.key === selectedExternalKey)
    if (localVisible || externalVisible) {
      return
    }
    const firstLocal = filteredRows[0]
    if (firstLocal) {
      if (selectedExternalKey !== null) {
        selectExternalKey(null)
      }
      if (selectedRowKey !== firstLocal.key) {
        selectAutomationRow(firstLocal.key)
      }
      return
    }
    const firstExternal = filteredExternalAutomationEntries[0]
    if (firstExternal && selectedExternalKey !== firstExternal.key) {
      selectExternalKey(firstExternal.key)
    }
  }, [
    activeListSearchQuery,
    filteredRows,
    filteredExternalAutomationEntries,
    selectAutomationRow,
    selectExternalKey,
    selectedExternalKey,
    selectedRowKey
  ])

  return {
    isListSearchQueryTooLarge,
    filteredRows,
    filteredExternalAutomationEntries,
    hasListItems: hostRowCount > 0,
    hasFilteredListItems: visibleRowCount > 0,
    // Why: the empty-state view reads rows-before and rows-after from here
    // rather than recomputing either count from its own props.
    searchCounts: { hostRowCount, visibleRowCount, searchActive: isListSearchActive }
  }
}

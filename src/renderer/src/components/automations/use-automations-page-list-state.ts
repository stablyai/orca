import { useCallback, useMemo } from 'react'
import { getWorktreePathBasenameFromId } from '../../../../shared/worktree/id'
import { buildExternalAutomationListEntries } from './external-automation-list-entries'
import { externalAutomationScopeEntries } from './external-automation-scope-gating'
import { externalAutomationUncheckedNotice } from './external-automation-unchecked-hosts'
import {
  filterAutomationListRows,
  filterExternalAutomationListEntries
} from './automation-list-view'
import { unscopedAutomationListRows } from './automation-list-row-identity'
import { useAutomationHostCatalog } from './use-automation-host-catalog'
import { useAutomationListSearch } from './use-automation-list-search'
import { useScopedExternalAutomations } from './use-scoped-external-automations'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** Host-qualified rows, external scopes, selection, and list-search projection. */
export function useAutomationsPageListState({
  store,
  local
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
}) {
  const { repoMap, worktreeMap, repoForRow, worktreeForRow, selectedId, setSelectedId } = store
  const {
    automations,
    failedAuthorityKeys,
    listSearchQuery,
    listFilter,
    selectedRowKey,
    selectedExternalKey,
    selectedAutomationRuns,
    workspaceNameCacheRef,
    selectExternalKey,
    setSelectedAutomationRunPageId,
    setSelectedRowKey
  } = local
  const hostCatalog = useAutomationHostCatalog({ failedAuthorityKeys })
  const externalScopeEntries = useMemo(
    () => externalAutomationScopeEntries(hostCatalog.entries, hostCatalog.resolution),
    [hostCatalog.entries, hostCatalog.resolution]
  )
  const scopedExternal = useScopedExternalAutomations({
    catalogEntries: hostCatalog.entries,
    scopeEntries: externalScopeEntries
  })
  const unscopedRows = useMemo(() => unscopedAutomationListRows(automations), [automations])
  const visibleRows = hostCatalog.rows.answered ? hostCatalog.rows.rows : unscopedRows
  const capturedAutomationOwners = hostCatalog.rows.capturedOwners
  const externalAutomationEntries = useMemo(
    () => buildExternalAutomationListEntries(scopedExternal.managers),
    [scopedExternal.managers]
  )
  const attributeFilteredRows = useMemo(
    () => filterAutomationListRows(visibleRows, listFilter),
    [listFilter, visibleRows]
  )
  const attributeFilteredExternalEntries = useMemo(
    () => filterExternalAutomationListEntries(externalAutomationEntries, listFilter),
    [externalAutomationEntries, listFilter]
  )
  const selectAutomationRow = useCallback(
    (rowKey: string | null): void => {
      const row = rowKey === null ? null : visibleRows.find((candidate) => candidate.key === rowKey)
      setSelectedAutomationRunPageId(null)
      setSelectedRowKey(row?.key ?? null)
      setSelectedId(row?.automation.id ?? null)
    },
    [setSelectedAutomationRunPageId, setSelectedId, setSelectedRowKey, visibleRows]
  )
  const selectedExternal =
    externalAutomationEntries.find((entry) => entry.key === selectedExternalKey) ??
    (visibleRows.length === 0 ? (externalAutomationEntries[0] ?? null) : null)
  const selectedRow =
    selectedExternal === null
      ? selectedId
        ? (visibleRows.find(
            (row) => row.key === selectedRowKey && row.automation.id === selectedId
          ) ??
          visibleRows.find((row) => row.automation.id === selectedId) ??
          null)
        : (visibleRows[0] ?? null)
      : null
  const selected = selectedRow?.automation ?? null
  const {
    isListSearchQueryTooLarge,
    filteredRows,
    filteredExternalAutomationEntries,
    hasListItems,
    hasFilteredListItems,
    searchCounts
  } = useAutomationListSearch({
    listSearchQuery,
    rows: attributeFilteredRows,
    externalAutomationEntries: attributeFilteredExternalEntries,
    repoMap,
    worktreeMap,
    selectedRowKey: selectedRow?.key ?? null,
    selectedExternalKey,
    selectAutomationRow,
    selectExternalKey
  })
  const selectedAutomationRunsWithWorkspaceNames = useMemo(
    () =>
      selectedAutomationRuns.runs.map((run) => {
        if (!run.workspaceId || run.workspaceDisplayName?.trim()) {
          return run
        }
        const displayName =
          (selectedRow
            ? worktreeForRow(selectedRow, repoForRow(selectedRow), run.workspaceId)?.displayName
            : worktreeMap.get(run.workspaceId)?.displayName) ??
          workspaceNameCacheRef.current.get(run.workspaceId) ??
          getWorktreePathBasenameFromId(run.workspaceId)
        const trimmedDisplayName = displayName?.trim()
        return trimmedDisplayName ? { ...run, workspaceDisplayName: trimmedDisplayName } : run
      }),
    [
      repoForRow,
      selectedAutomationRuns.runs,
      selectedRow,
      worktreeForRow,
      worktreeMap,
      workspaceNameCacheRef
    ]
  )
  const externalManagersUncheckedNotice = useMemo(
    () => externalAutomationUncheckedNotice(scopedExternal.failures, hostCatalog.entries),
    [hostCatalog.entries, scopedExternal.failures]
  )

  return {
    hostCatalog,
    externalScopeEntries,
    scopedExternal,
    unscopedRows,
    visibleRows,
    capturedAutomationOwners,
    externalAutomationEntries,
    externalManagersUncheckedNotice,
    selectedExternal,
    selectedRow,
    selected,
    selectedAutomationRunsWithWorkspaceNames,
    isListSearchQueryTooLarge,
    filteredRows,
    filteredExternalAutomationEntries,
    hasListItems,
    hasFilteredListItems,
    searchCounts,
    selectAutomationRow
  }
}

export type AutomationsPageListState = ReturnType<typeof useAutomationsPageListState>

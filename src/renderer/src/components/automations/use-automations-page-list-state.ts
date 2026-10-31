import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  hostStableKey,
  ownerKey,
  toStableCatalogRef
} from '../../../../shared/automation-owner-key'
import { resolveAutomationRunTarget } from './automation-run-open-target'
import { capturedAutomationOwner, capturedAutomationOwnerKey } from './automation-captured-owner'
import type { AutomationRun } from '../../../../shared/automations-types'
import { getWorktreePathBasenameFromId } from '../../../../shared/worktree/id'
import { buildExternalAutomationListEntries } from './external-automation-list-entries'
import { externalAutomationScopeEntries } from './external-automation-scope-gating'
import { externalAutomationUncheckedNotice } from './external-automation-unchecked-hosts'
import {
  buildAutomationListViewItems,
  filterAutomationListRows,
  filterExternalAutomationListEntries,
  sortAutomationListViewItems
} from './automation-list-view'
import { getIntlLocale } from '@/i18n/i18n'
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
  store: Pick<AutomationsPageStoreState, 'repoMap' | 'worktreeMap' | 'selectedId' | 'setSelectedId'>
  local: Pick<
    AutomationsPageLocalState,
    | 'automations'
    | 'failedAuthorityKeys'
    | 'listSearchQuery'
    | 'listFilter'
    | 'listSort'
    | 'selectedRowKey'
    | 'selectedExternalKey'
    | 'selectedAutomationRuns'
    | 'workspaceNameCacheRef'
    | 'selectExternalKey'
    | 'setSelectedAutomationRunPageId'
    | 'setSelectedRowKey'
    | 'setRunHistoryAcquisitionToken'
  >
}) {
  const { repoMap, worktreeMap, selectedId, setSelectedId } = store
  const {
    automations,
    failedAuthorityKeys,
    listSearchQuery,
    listFilter,
    listSort,
    selectedRowKey,
    selectedExternalKey,
    selectedAutomationRuns,
    workspaceNameCacheRef,
    selectExternalKey,
    setSelectedAutomationRunPageId,
    setSelectedRowKey,
    setRunHistoryAcquisitionToken
  } = local
  const hostCatalog = useAutomationHostCatalog({ failedAuthorityKeys })
  const externalScopeEntries = useMemo(
    () => externalAutomationScopeEntries(hostCatalog.entries, hostCatalog.resolution),
    [hostCatalog.entries, hostCatalog.resolution]
  )
  const scopedExternal = useScopedExternalAutomations({
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
      setRunHistoryAcquisitionToken((token) => token + 1)
      setSelectedAutomationRunPageId(null)
      setSelectedRowKey(row?.key ?? null)
      setSelectedId(row?.automation.id ?? null)
    },
    [
      setSelectedAutomationRunPageId,
      setSelectedId,
      setSelectedRowKey,
      setRunHistoryAcquisitionToken,
      visibleRows
    ]
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
  const runTargetFor = useCallback(
    (run: AutomationRun) => {
      const state = useAppStore.getState()
      const acquiredOwner = selectedAutomationRuns.capturedOwner?.owner
      const entry = acquiredOwner
        ? hostCatalog.entries.find(
            (candidate) => candidate.stableKey === hostStableKey(toStableCatalogRef(acquiredOwner))
          )
        : null
      const acquiredOwnerCurrent =
        !entry ||
        (entry.catalogState !== 'removed' &&
          (!entry.owner
            ? entry.catalogState === 'unhydrated'
            : !!acquiredOwner && ownerKey(entry.owner) === ownerKey(acquiredOwner)))
      const fresh =
        acquiredOwnerCurrent &&
        (!capturedAutomationOwners.has(selectedAutomationRuns.rowKey ?? '') ||
          selectedAutomationRuns.ownerKey ===
            capturedAutomationOwnerKey(
              capturedAutomationOwner(capturedAutomationOwners, selectedAutomationRuns.rowKey)
            ))
      return resolveAutomationRunTarget(
        fresh ? state : { ...state, worktreesByRepo: {}, folderWorkspaces: [] },
        run,
        fresh ? selectedAutomationRuns.authority : null
      )
    },
    [capturedAutomationOwners, hostCatalog.entries, selectedAutomationRuns]
  )
  const selectedAutomationRunsWithWorkspaceNames = useMemo(
    () =>
      selectedAutomationRuns.runs.map((run) => {
        if (!run.workspaceId || run.workspaceDisplayName?.trim()) {
          return run
        }
        const target = runTargetFor(run)
        const cacheKey = `${selectedAutomationRuns.rowKey}:${selectedAutomationRuns.ownerKey}:${run.id}`
        const displayName =
          target.worktree?.displayName ??
          workspaceNameCacheRef.current.get(cacheKey) ??
          getWorktreePathBasenameFromId(run.workspaceId)
        if (target.worktree?.displayName) {
          workspaceNameCacheRef.current.set(cacheKey, target.worktree.displayName)
        }
        return displayName?.trim() ? { ...run, workspaceDisplayName: displayName.trim() } : run
      }),
    [runTargetFor, selectedAutomationRuns, workspaceNameCacheRef]
  )
  const externalManagersUncheckedNotice = useMemo(
    () => externalAutomationUncheckedNotice(scopedExternal.failures, hostCatalog.entries),
    [hostCatalog.entries, scopedExternal.failures]
  )
  // Pass locale into the sort memo because collation can change without row writes.
  const sortLocale = getIntlLocale()
  const sortedListItems = useMemo(
    () =>
      sortAutomationListViewItems(
        buildAutomationListViewItems({
          rows: filteredRows,
          externalEntries: filteredExternalAutomationEntries
        }),
        listSort,
        sortLocale
      ),
    [filteredExternalAutomationEntries, filteredRows, listSort, sortLocale]
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
    runTargetFor,
    isListSearchQueryTooLarge,
    filteredRows,
    filteredExternalAutomationEntries,
    sortedListItems,
    hasListItems,
    hasFilteredListItems,
    searchCounts,
    selectAutomationRow
  }
}

export type AutomationsPageListState = ReturnType<typeof useAutomationsPageListState>

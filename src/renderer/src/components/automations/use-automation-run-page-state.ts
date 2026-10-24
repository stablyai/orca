import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  getAutomationAuthorityTarget,
  getAutomationHostTargetKey,
  getAutomationTargetFromHostId
} from './automation-host-client'
import { ALL_AUTOMATION_HOSTS_FILTER } from '../../../../shared/automation-host-filter'
import { useAppStore } from '@/store'
import {
  getAutomationRunOwnerEnvironmentId,
  resolveAutomationRunTerminalTarget
} from './automation-run-open-target'
import { canRerunAutomationRun, getAutomationRunViewState } from './automation-run-view-state'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import type { AutomationsPageListState } from './use-automations-page-list-state'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageSetupState } from './use-automations-page-setup-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** Navigation and terminal affordances for the selected automation run. */
export function useAutomationRunPageState({
  store,
  local,
  list,
  setup
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  list: AutomationsPageListState
  setup: AutomationsPageSetupState
}) {
  const {
    worktreeMap,
    repoForRow,
    worktreeForRow,
    pendingAutomationRunNavigation,
    setPendingAutomationRunNavigation,
    selectedId,
    setSelectedId,
    unifiedTabsByWorktree,
    terminalLayoutsByTabId,
    ptyIdsByTabId
  } = store
  const {
    isLoading,
    automationHostTargetKey,
    automations,
    setSelectedAutomationRunPageId,
    setActivePaneTab,
    rerunRunIdsInFlight,
    selectedExternalKey,
    selectExternalKey,
    pageView,
    setPageView,
    setRunPageOrigin,
    isDetailOpen,
    setIsDetailOpen
  } = local
  const {
    selected,
    selectedRow,
    visibleRows,
    externalAutomationEntries,
    hostCatalog,
    selectAutomationRow
  } = list
  const { selectedRuns, selectedRunsReady, selectedRunsNotice, selectedAutomationRunPage } = setup

  useEffect(() => {
    if (!isDetailOpen || pendingAutomationRunNavigation) {
      return
    }
    const hasSelectedLocal = selectedRow?.key
      ? visibleRows.some((row) => row.key === selectedRow.key)
      : selectedId !== null && selectedRow !== null
    const hasSelectedExternal =
      selectedExternalKey !== null &&
      externalAutomationEntries.some((entry) => entry.key === selectedExternalKey)
    if (hasSelectedLocal || hasSelectedExternal) {
      return
    }
    setIsDetailOpen(false)
    setSelectedAutomationRunPageId(null)
    setActivePaneTab('overview')
  }, [
    isDetailOpen,
    externalAutomationEntries,
    visibleRows,
    pendingAutomationRunNavigation,
    selectedExternalKey,
    selectedId,
    selectedRow,
    setActivePaneTab,
    setIsDetailOpen,
    setSelectedAutomationRunPageId
  ])
  useEffect(() => {
    if (!pendingAutomationRunNavigation) {
      return
    }
    const pending = pendingAutomationRunNavigation
    if (pending.runId && pageView !== 'run') {
      setRunPageOrigin(pageView === 'automations' && isDetailOpen ? 'automation' : 'runs')
      setPageView('run')
    }
    if (isLoading) {
      return
    }
    const pendingTargetKey = getAutomationHostTargetKey(
      getAutomationTargetFromHostId(pending.hostId)
    )
    if (automationHostTargetKey !== pendingTargetKey) {
      return
    }
    const pendingAutomation = automations.find(
      (automation) => automation.id === pending.automationId
    )
    if (selectedExternalKey !== null) {
      selectExternalKey(null)
    }
    if (!pendingAutomation) {
      setSelectedId(pending.automationId)
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      if (pageView === 'run') {
        setPageView('runs')
      }
      toast.message(
        translate(
          'auto.components.automations.AutomationsPage.pendingAutomationMissing',
          'Automation no longer available.'
        )
      )
      return
    }
    const pendingRow = visibleRows.find(
      (row) =>
        row.automation.id === pending.automationId &&
        (!row.catalogRef ||
          getAutomationHostTargetKey(getAutomationAuthorityTarget(row.catalogRef.authority)) ===
            pendingTargetKey)
    )
    if (!pendingRow) {
      if (hostCatalog.resolution.effective.kind !== 'all') {
        hostCatalog.selectHost(ALL_AUTOMATION_HOSTS_FILTER)
      }
      return
    }
    if (selectedId !== pending.automationId || selectedRow?.key !== pendingRow.key) {
      selectAutomationRow(pendingRow.key)
      setIsDetailOpen(true)
      return
    }
    if (!pending.runId) {
      setIsDetailOpen(true)
      setActivePaneTab('overview')
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      setPageView('automations')
      return
    }
    if (!selectedRunsReady) {
      return
    }
    if (selectedRunsNotice) {
      setIsDetailOpen(true)
      setActivePaneTab('runs')
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      setPageView('automations')
      return
    }
    setIsDetailOpen(true)
    setActivePaneTab('runs')
    const pendingRun = selectedRuns.find((run) => run.id === pending.runId)
    if (pendingRun) {
      setSelectedAutomationRunPageId(pending.runId)
      setPendingAutomationRunNavigation(null)
      setPageView('run')
      return
    }
    setSelectedAutomationRunPageId(null)
    setPendingAutomationRunNavigation(null)
    if (pageView === 'run') {
      setPageView('runs')
    }
    toast.message(
      translate(
        'auto.components.automations.AutomationsPage.pendingAutomationRunMissing',
        'Run history no longer available.'
      )
    )
  }, [
    automations,
    automationHostTargetKey,
    isLoading,
    isDetailOpen,
    hostCatalog,
    selectAutomationRow,
    visibleRows,
    pendingAutomationRunNavigation,
    pageView,
    selectExternalKey,
    selectedExternalKey,
    selectedId,
    selectedRow,
    selectedRuns,
    selectedRunsReady,
    selectedRunsNotice,
    setActivePaneTab,
    setIsDetailOpen,
    setPendingAutomationRunNavigation,
    setPageView,
    setRunPageOrigin,
    setSelectedAutomationRunPageId,
    setSelectedId
  ])

  const activeTerminalTabIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tabs of Object.values(unifiedTabsByWorktree)) {
      for (const tab of tabs) {
        if (tab.contentType === 'terminal') {
          ids.add(tab.entityId)
        }
      }
    }
    return ids
  }, [unifiedTabsByWorktree])
  const selectedAutomationRunPageWorktree = selectedAutomationRunPage?.workspaceId
    ? selectedRow
      ? (worktreeForRow(
          selectedRow,
          repoForRow(selectedRow),
          selectedAutomationRunPage.workspaceId
        ) ?? null)
      : (worktreeMap.get(selectedAutomationRunPage.workspaceId) ?? null)
    : null
  const selectedAutomationRunPageWorkspaceDisplay = selectedAutomationRunPage
    ? getAutomationRunWorkspaceDisplay({
        run: selectedAutomationRunPage,
        worktree: selectedAutomationRunPageWorktree
      })
    : null
  const selectedAutomationRunPageOwnerEnvironmentId = useAppStore((state) =>
    selectedAutomationRunPageWorktree
      ? getAutomationRunOwnerEnvironmentId(
          state,
          selectedAutomationRunPage?.workspaceId,
          selectedAutomationRunPageWorktree.hostId
        )
      : null
  )
  const selectedAutomationRunPageViewState = selectedAutomationRunPage
    ? getAutomationRunViewState({
        run: selectedAutomationRunPage,
        workspaceExists: Boolean(selectedAutomationRunPageWorktree),
        terminalTargetExists:
          resolveAutomationRunTerminalTarget(
            selectedAutomationRunPage,
            {
              hasTerminalTab: (tabId) => activeTerminalTabIds.has(tabId),
              terminalLayoutsByTabId,
              ptyIdsByTabId
            },
            selectedAutomationRunPageOwnerEnvironmentId
          ) !== null,
        terminalOnPairedServer: selectedAutomationRunPageOwnerEnvironmentId !== null
      })
    : null
  const canRerunSelectedAutomationRunPage =
    selectedAutomationRunPage !== null &&
    canRerunAutomationRun({ automation: selected, run: selectedAutomationRunPage })
  const isSelectedAutomationRunPageRerunPending =
    selectedAutomationRunPage !== null && rerunRunIdsInFlight.has(selectedAutomationRunPage.id)

  return {
    selectedAutomationRunPageWorkspaceDisplay,
    selectedAutomationRunPageViewState,
    canRerunSelectedAutomationRunPage,
    isSelectedAutomationRunPageRerunPending
  }
}

export type AutomationRunPageState = ReturnType<typeof useAutomationRunPageState>

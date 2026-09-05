import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getAutomationHostTargetKey, getAutomationTargetFromHostId } from './automation-host-client'
import {
  canOpenAutomationRunOpenTarget,
  getAutomationRunOpenTabId
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
    selectedAutomationRuns,
    setSelectedAutomationRunPageId,
    setActivePaneTab,
    rerunRunIdsInFlight,
    selectedExternalKey,
    selectExternalKey,
    setSelectedExternalRunPage,
    pageView,
    setPageView,
    isDetailOpen,
    setIsDetailOpen
  } = local
  const { selected, selectedRow } = list
  const { selectedRuns, selectedAutomationRunPage } = setup

  useEffect(() => {
    if (!isDetailOpen || pendingAutomationRunNavigation) {
      return
    }
    const hasSelectedLocal = selectedRow?.key
      ? list.visibleRows.some((row) => row.key === selectedRow.key)
      : selectedId !== null && selectedRow !== null
    const hasSelectedExternal =
      selectedExternalKey !== null &&
      list.externalAutomationEntries.some((entry) => entry.key === selectedExternalKey)
    if (hasSelectedLocal || hasSelectedExternal) {
      return
    }
    setIsDetailOpen(false)
    setSelectedAutomationRunPageId(null)
    setSelectedExternalRunPage(null)
    setActivePaneTab('overview')
  }, [
    isDetailOpen,
    list.externalAutomationEntries,
    list.visibleRows,
    pendingAutomationRunNavigation,
    selectedExternalKey,
    selectedId,
    selectedRow,
    setActivePaneTab,
    setIsDetailOpen,
    setSelectedAutomationRunPageId,
    setSelectedExternalRunPage
  ])
  useEffect(() => {
    if (!pendingAutomationRunNavigation || isLoading) {
      return
    }
    const pending = pendingAutomationRunNavigation
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
    if (selectedId !== pending.automationId) {
      setSelectedId(pending.automationId)
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
    if (
      selectedAutomationRuns.notice &&
      selectedAutomationRuns.automationId === pending.automationId
    ) {
      setIsDetailOpen(true)
      setActivePaneTab('runs')
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      if (pageView === 'run') {
        setPageView('runs')
      }
      return
    }
    if (selectedAutomationRuns.automationId !== pending.automationId) {
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
    pendingAutomationRunNavigation,
    pageView,
    selectExternalKey,
    selectedAutomationRuns.automationId,
    selectedAutomationRuns.notice,
    selectedExternalKey,
    selectedId,
    selectedRuns,
    setActivePaneTab,
    setIsDetailOpen,
    setPendingAutomationRunNavigation,
    setPageView,
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
  const selectedAutomationRunPageOpenTabId = selectedAutomationRunPage
    ? getAutomationRunOpenTabId(selectedAutomationRunPage)
    : null
  const selectedAutomationRunPageViewState = selectedAutomationRunPage
    ? getAutomationRunViewState({
        run: selectedAutomationRunPage,
        workspaceExists: Boolean(selectedAutomationRunPageWorktree),
        terminalTargetExists: canOpenAutomationRunOpenTarget({
          run: selectedAutomationRunPage,
          terminalTabExists: selectedAutomationRunPageOpenTabId
            ? activeTerminalTabIds.has(selectedAutomationRunPageOpenTabId)
            : false,
          currentLayout: selectedAutomationRunPageOpenTabId
            ? terminalLayoutsByTabId[selectedAutomationRunPageOpenTabId]
            : null,
          livePtyIds: selectedAutomationRunPageOpenTabId
            ? (ptyIdsByTabId[selectedAutomationRunPageOpenTabId] ?? [])
            : []
        })
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

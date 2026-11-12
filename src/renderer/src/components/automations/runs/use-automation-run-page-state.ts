import { useEffect } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import {
  getAutomationAuthorityTarget,
  getAutomationHostTargetKey,
  getAutomationListedTargetFromHostId
} from '../hosts/automation-host-client'
import { ALL_AUTOMATION_HOSTS_FILTER } from '../../../../../shared/automations/ownership/automation-host-filter'
import { canRerunAutomationRun } from './automation-run-view-state'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import type { AutomationsPageListState } from '../listing/use-automations-page-list-state'
import type { AutomationsPageLocalState } from '../use-automations-page-local-state'
import type { AutomationsPageSetupState } from '../authoring/use-automations-page-setup-state'
import type { AutomationsPageStoreState } from '../use-automations-page-store-state'

/** Navigation and terminal affordances for the selected automation run. */
export function useAutomationRunPageState({
  store,
  local,
  list,
  setup
}: {
  store: Pick<
    AutomationsPageStoreState,
    | 'pendingAutomationRunNavigation'
    | 'setPendingAutomationRunNavigation'
    | 'runtimeEnvironments'
    | 'selectedId'
    | 'setSelectedId'
  >
  local: Pick<
    AutomationsPageLocalState,
    | 'isLoading'
    | 'automationHostTargetKey'
    | 'automations'
    | 'setSelectedAutomationRunPageId'
    | 'setActivePaneTab'
    | 'rerunRunIdsInFlight'
    | 'selectedExternalKey'
    | 'selectExternalKey'
    | 'pageView'
    | 'setPageView'
    | 'setRunPageOrigin'
    | 'setRunNotFound'
    | 'isDetailOpen'
    | 'setIsDetailOpen'
  >
  list: AutomationsPageListState
  setup: Pick<
    AutomationsPageSetupState,
    'selectedRuns' | 'selectedRunsReady' | 'selectedRunsNotice' | 'selectedAutomationRunPage'
  >
}) {
  const t = useTranslate()
  const {
    pendingAutomationRunNavigation,
    setPendingAutomationRunNavigation,
    runtimeEnvironments,
    selectedId,
    setSelectedId
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
    setRunNotFound,
    isDetailOpen,
    setIsDetailOpen
  } = local
  const {
    selected,
    selectedRow,
    visibleRows,
    externalAutomationEntries,
    hostCatalog,
    selectAutomationRow,
    scopedExternal
  } = list
  const { selectedRuns, selectedRunsReady, selectedRunsNotice, selectedAutomationRunPage } = setup

  useEffect(() => {
    if (
      isLoading ||
      scopedExternal.loading ||
      !isDetailOpen ||
      pendingAutomationRunNavigation ||
      (pageView === 'run' && selectedAutomationRunPage)
    ) {
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
    isLoading,
    scopedExternal.loading,
    isDetailOpen,
    pageView,
    selectedAutomationRunPage,
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
    if (pending.runId) {
      // Why: a deep link (workspace card, notification) undoes to its automation, not the Runs list.
      setRunPageOrigin(pending.origin ?? 'automation')
      setPageView('run')
    }
    if (isLoading) {
      return
    }
    const pendingTargetKey = getAutomationHostTargetKey(
      getAutomationListedTargetFromHostId(pending.hostId, { runtimeEnvironments })
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
      setRunNotFound({ kind: 'automation', automationId: pending.automationId })
      setPageView('run')
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
      setActivePaneTab(pending.paneTab ?? 'overview')
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      setPageView('automations')
      return
    }
    if (!selectedRunsReady) {
      return
    }
    if (selectedRunsNotice) {
      // The recent-runs rail shows why the history could not be read.
      setIsDetailOpen(true)
      setActivePaneTab('overview')
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      setPageView('automations')
      return
    }
    setIsDetailOpen(true)
    setActivePaneTab(pending.origin === 'automationRuns' ? 'runs' : 'overview')
    const pendingRun = selectedRuns.find((run) => run.id === pending.runId)
    if (pendingRun) {
      setRunPageOrigin(pending.origin ?? 'automation')
      setSelectedAutomationRunPageId(pending.runId)
      setPendingAutomationRunNavigation(null)
      setPageView('run')
      return
    }
    setSelectedAutomationRunPageId(null)
    setPendingAutomationRunNavigation(null)
    setRunNotFound({ kind: 'run', automationId: pending.automationId })
    setPageView('run')
  }, [
    automations,
    automationHostTargetKey,
    isLoading,
    hostCatalog,
    selectAutomationRow,
    visibleRows,
    pendingAutomationRunNavigation,
    pageView,
    runtimeEnvironments,
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
    setRunNotFound,
    setSelectedAutomationRunPageId,
    setSelectedId
  ])

  const selectedRunTarget = selectedAutomationRunPage
    ? list.runTargetFor(selectedAutomationRunPage)
    : null
  const selectedAutomationRunPageWorkspaceDisplay = selectedAutomationRunPage
    ? getAutomationRunWorkspaceDisplay(
        {
          run: selectedAutomationRunPage,
          worktree: selectedRunTarget?.worktree ?? null
        },
        t
      )
    : null
  const selectedAutomationRunPageViewState = selectedRunTarget?.viewState ?? null
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

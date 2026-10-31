import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { AutomationsPageSkeleton } from './AutomationsPageSkeleton'
import { capturedAutomationOwner, capturedAutomationOwnerKey } from './automation-captured-owner'
import {
  getAutomationHostTargetFromKey,
  getAutomationHostTargetKey
} from './automation-host-client'
import { createAutomationRunOutputActions } from './automation-run-output-actions'
import type { AutomationsPageController } from './use-automations-page-controller'
import { selectedAutomationRunHistoryTarget } from './use-selected-automation-run-history'

export function AutomationRunPageSurface({
  controller,
  onBack
}: {
  controller: AutomationsPageController
  onBack: () => void
}): React.JSX.Element {
  const { store, list, destination, setup, local, runPage, runActions, openRunWorkspace } =
    controller
  const row = list.selectedRow
  const run = setup.selectedAutomationRunPage
  const target = row
    ? selectedAutomationRunHistoryTarget({
        selected: row,
        context: destination.automationDispatchContext,
        navigation: store.pendingAutomationRunNavigation ?? local.selectedAutomationRuns.navigation,
        legacyTarget: destination.automationHostTargetFor
      })
    : null
  const targetKey = target ? getAutomationHostTargetKey(target) : null
  const ownerKey = capturedAutomationOwnerKey(
    capturedAutomationOwner(destination.automationDispatchContext.capturedOwners, row?.key ?? null)
  )
  const runId = run?.id
  const outputActions = useMemo(() => {
    const target = getAutomationHostTargetFromKey(targetKey)
    return target && runId ? createAutomationRunOutputActions(target, runId) : null
  }, [targetKey, runId])
  if (store.pendingAutomationRunNavigation?.runId) {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <LoadingSpinner className="size-4" />
        {translate('auto.components.automations.AutomationRunsDashboard.loading', 'Loading runs…')}
      </div>
    )
  }
  if (!run || !row || !outputActions) {
    return <AutomationsPageSkeleton />
  }
  return (
    <AutomationRunDetailsPage
      key={`${targetKey}:${ownerKey}:${runId}`}
      automation={list.selected}
      run={run}
      relativeNow={local.relativeNow}
      workspaceDisplay={runPage.selectedAutomationRunPageWorkspaceDisplay}
      viewState={runPage.selectedAutomationRunPageViewState}
      canRerun={runPage.canRerunSelectedAutomationRunPage}
      isRerunPending={runPage.isSelectedAutomationRunPageRerunPending}
      onRerun={() => runActions.rerunAutomationRun(row, run)}
      onOpenWorkspace={() => openRunWorkspace(run)}
      onBack={onBack}
      outputActions={outputActions}
    />
  )
}

import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { AutomationEditorDialog } from './AutomationEditorDialog'
import { AutomationsDetailPane } from './AutomationsDetailPane'
import { AutomationsPageSkeleton } from './AutomationsPageSkeleton'
import { getAutomationAuthorityTarget } from './automation-host-client'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import { AutomationsPageTopBar } from './AutomationsPageTopBar'
import type { AutomationsPageController } from './use-automations-page-controller'
import { AutomationRunsDashboardSurface } from './AutomationRunsDashboardSurface'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { AutomationsPageDeleteDialogs } from './AutomationsPageDeleteDialogs'
import { AutomationsPageListPanel } from './AutomationsPageListPanel'
export function AutomationsPageSurface({
  controller
}: {
  controller: AutomationsPageController
}): React.JSX.Element {
  const {
    store,
    local,
    list,
    destination,
    runsDashboard,
    destinationForm,
    setup,
    runPage,
    presentation,
    pageRefresh,
    draftEffects,
    editorActions,
    saveAutomation,
    managementActions,
    runActions,
    externalActions,
    openRunWorkspace
  } = controller
  const {
    projectHostSetups,
    repoMap,
    worktreeMap,
    settings,
    repoForRow,
    worktreeForRow,
    setPendingAutomationRunNavigation
  } = store
  const {
    createOpen,
    editingAutomationId,
    isSaving,
    editingExternalTarget,
    createTarget,
    automationYamlHooksByRepoKey,
    draft,
    setCreateOpen,
    deleteTarget,
    dontAskDeleteAgain,
    deleteConfirmButtonRef,
    setDeleteTarget,
    setDontAskDeleteAgain,
    externalDeleteTarget,
    externalDeleteConfirmButtonRef,
    setExternalDeleteTarget,
    relativeNow,
    externalActionKey,
    activePaneTab,
    setActivePaneTab,
    selectedExternalRunPage,
    setSelectedExternalRunPage,
    setSelectedAutomationRunPageId,
    setSelectedAutomationRuns,
    setRunHistoryReloadToken,
    isDetailOpen,
    setIsDetailOpen,
    ownerAction,
    setOwnerAction,
    editorNotice,
    setEditorNotice,
    editorNoticeHost,
    setEditorNoticeHost,
    isLoading,
    pageView,
    setPageView,
    runPageOrigin,
    setRunPageOrigin
  } = local
  const { hostCatalog, hasListItems, selected, selectedRow, selectedExternal } = list
  const selectedAutomationRunPage = setup.selectedAutomationRunPage
  const selectedRunWorktreeMap = useMemo(() => {
    if (!selectedRow) {
      return worktreeMap
    }
    const repo = repoForRow(selectedRow)
    return new Map(
      setup.selectedRuns.flatMap((run) => {
        const worktree = worktreeForRow(selectedRow, repo, run.workspaceId)
        return worktree ? [[worktree.id, worktree] as const] : []
      })
    )
  }, [repoForRow, selectedRow, setup.selectedRuns, worktreeForRow, worktreeMap])
  const runSelectedRowAction = (action: (row: AutomationListRow) => void): void => {
    if (selectedRow) {
      action(selectedRow)
    }
  }
  const recoverOwnerAction = (
    action: AutomationHostRecoveryAction,
    host = ownerAction?.host ?? null
  ): void => {
    setOwnerAction(null)
    hostCatalog.recover(action, host)
    if (action === 'retry') {
      void pageRefresh.refresh()
    }
  }
  const openAutomationRunPage = (run: (typeof setup.selectedRuns)[number]): void => {
    externalActions.openAutomationRunPage(run)
    setRunPageOrigin('automation')
    setPageView('run')
  }
  const showAutomationsList = (): void => {
    setPageView('automations')
    setSelectedAutomationRunPageId(null)
    setIsDetailOpen(false)
    setActivePaneTab('overview')
  }
  const showRunsDashboard = (): void => {
    setPageView('runs')
    setSelectedAutomationRunPageId(null)
    setIsDetailOpen(false)
    setActivePaneTab('overview')
  }
  const showAutomationDetails = (): void => {
    setPageView('automations')
    setSelectedAutomationRunPageId(null)
    setIsDetailOpen(true)
    setActivePaneTab('runs')
  }
  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background pt-5 text-foreground md:pt-6">
      <AutomationsPageTopBar
        pageView={pageView}
        isDetailOpen={isDetailOpen}
        selectedAutomationName={selected?.name}
        runPageOrigin={runPageOrigin}
        ownerNotice={ownerAction?.notice ?? null}
        recoverOwnerAction={recoverOwnerAction}
        dismissOwnerAction={() => setOwnerAction(null)}
        showAutomationsList={showAutomationsList}
        showRunsDashboard={showRunsDashboard}
        showAutomationDetails={showAutomationDetails}
      />
      <AutomationEditorDialog
        open={createOpen}
        isEditing={editingAutomationId !== null}
        isSaving={isSaving}
        canSave={presentation.canSaveDraft}
        isEditingExternal={editingExternalTarget !== null}
        createTarget={createTarget}
        createDestination={destination.createDestination.control}
        editDestination={
          destinationForm.isOrcaForm ? destinationForm.editDestinationControl : undefined
        }
        notice={editorNotice}
        onNoticeRecover={(action) => {
          const host = editorNoticeHost ?? destination.editorRecoveryHost
          setEditorNotice(null)
          setEditorNoticeHost(null)
          hostCatalog.recover(action, host)
          if (action === 'retry') {
            void pageRefresh.refresh()
          }
        }}
        onNoticeDismiss={() => {
          setEditorNotice(null)
          setEditorNoticeHost(null)
        }}
        repos={destinationForm.dialogRepos}
        projectHostSetups={projectHostSetups}
        automationYamlHooksByRepoKey={automationYamlHooksByRepoKey}
        getAutomationHooksCacheKey={setup.getAutomationHooksCacheKey}
        repoMap={repoMap}
        worktrees={destinationForm.dialogWorktrees}
        settings={settings}
        draft={draft}
        onProjectChange={editorActions.handleProjectChange}
        getRepoHostLabel={presentation.getAutomationRepoHostLabel}
        allowAddProject={
          !destinationForm.isOrcaForm ||
          (editingAutomationId !== null
            ? destinationForm.editHostResolution.status === 'ready'
              ? getAutomationAuthorityTarget(destinationForm.editHostResolution.authority).kind ===
                'local'
              : destinationForm.automationDialogTarget.kind === 'local'
            : destinationForm.automationDialogTarget.kind === 'local')
        }
        onCreateTargetChange={draftEffects.handleCreateTargetChange}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) {
            setEditorNotice(null)
            setEditorNoticeHost(null)
          }
        }}
        onDraftChange={editorActions.handleDraftChange}
        onSetupDecisionTouched={setup.markSetupDecisionTouched}
        onApplyTemplate={draftEffects.applyTemplateToDraft}
        onSave={() => void saveAutomation()}
      />
      <AutomationsPageDeleteDialogs
        deleteTarget={deleteTarget?.automation ?? null}
        dontAskDeleteAgain={dontAskDeleteAgain}
        deleteConfirmButtonRef={deleteConfirmButtonRef}
        setDeleteTarget={setDeleteTarget}
        setDontAskDeleteAgain={setDontAskDeleteAgain}
        confirmDeleteAutomation={() => void managementActions.confirmDeleteAutomation()}
        externalDeleteTarget={externalDeleteTarget}
        externalDeleteConfirmButtonRef={externalDeleteConfirmButtonRef}
        setExternalDeleteTarget={setExternalDeleteTarget}
        confirmDeleteExternalAutomation={() =>
          void externalActions.confirmDeleteExternalAutomation()
        }
      />
      {pageView === 'runs' ? (
        <AutomationRunsDashboardSurface
          rows={list.visibleRows}
          entries={runsDashboard.entries}
          failures={runsDashboard.failures}
          loading={runsDashboard.loading}
          hasMore={runsDashboard.hasMore}
          onLoadMore={runsDashboard.loadMore}
          now={relativeNow}
          onRefresh={() => setRunHistoryReloadToken((token) => token + 1)}
          setPageView={setPageView}
          setRunPageOrigin={setRunPageOrigin}
          selectAutomationRow={list.selectAutomationRow}
          setPendingAutomationRunNavigation={setPendingAutomationRunNavigation}
          setIsDetailOpen={setIsDetailOpen}
        />
      ) : pageView === 'run' && selectedAutomationRunPage ? (
        <AutomationRunDetailsPage
          automation={selected}
          run={selectedAutomationRunPage}
          relativeNow={relativeNow}
          workspaceDisplay={runPage.selectedAutomationRunPageWorkspaceDisplay}
          viewState={runPage.selectedAutomationRunPageViewState}
          canRerun={runPage.canRerunSelectedAutomationRunPage}
          isRerunPending={runPage.isSelectedAutomationRunPageRerunPending}
          onRerun={() =>
            runSelectedRowAction((row) =>
              runActions.rerunAutomationRun(row, selectedAutomationRunPage)
            )
          }
          onOpenWorkspace={() => openRunWorkspace(selectedAutomationRunPage)}
          onBack={runPageOrigin === 'automation' ? showAutomationDetails : showRunsDashboard}
        />
      ) : pageView === 'run' ? (
        <AutomationsPageSkeleton />
      ) : isLoading && !hasListItems ? (
        <AutomationsPageSkeleton />
      ) : isDetailOpen && (selected || selectedExternal) ? (
        <AutomationsDetailPane
          selected={selected}
          selectedExternal={selectedExternal}
          selectedExternalRunPage={selectedExternalRunPage}
          selectedRuns={setup.selectedRuns}
          selectedRunsNotice={setup.selectedRunsNotice}
          selectedHostEntry={destination.rowRecoveryHost(selectedRow?.key ?? null)}
          recoverSelectedRuns={(action) => {
            hostCatalog.recover(action, destination.rowRecoveryHost(selectedRow?.key ?? null))
            setSelectedAutomationRuns((current) => ({ ...current, notice: null }))
            setRunHistoryReloadToken((token) => token + 1)
          }}
          activePaneTab={activePaneTab}
          relativeNow={relativeNow}
          externalActionKey={externalActionKey}
          selectedRepoDisplayName={
            presentation.selectedRepo?.displayName ??
            translate('auto.components.automations.AutomationsPage.13118faadf', 'Unknown project')
          }
          selectedRepoDefaultBaseRef={presentation.selectedRepo?.worktreeBaseRef ?? null}
          selectedWorkspaceName={
            selected?.workspaceMode === 'new_per_run'
              ? translate(
                  'auto.components.automations.AutomationsPage.cd8397cc32',
                  'New workspace each run'
                )
              : (presentation.selectedWorktree?.displayName ??
                translate(
                  'auto.components.automations.AutomationsPage.missingWorkspace',
                  'Missing workspace'
                ))
          }
          hostLabelById={presentation.hostLabelById}
          selectedRunNowAvailability={presentation.selectedRunNowAvailability}
          worktreeMap={selectedRunWorktreeMap}
          fetchExternalAutomationRuns={externalActions.fetchExternalAutomationRuns}
          onActivePaneTabChange={setActivePaneTab}
          onClearExternalRunPage={() => setSelectedExternalRunPage(null)}
          requestExternalAction={externalActions.requestExternalAction}
          openExternalRunPage={externalActions.openExternalRunPage}
          openEditExternalDialog={editorActions.openEditExternalDialog}
          runNow={() => runSelectedRowAction(runActions.runNow)}
          openEditDialog={() => runSelectedRowAction(editorActions.openEditDialog)}
          toggleAutomation={() => runSelectedRowAction(managementActions.toggleAutomation)}
          requestDeleteAutomation={() =>
            runSelectedRowAction(managementActions.requestDeleteAutomation)
          }
          openAutomationRunPage={openAutomationRunPage}
          onBackToList={() => {
            setIsDetailOpen(false)
            setSelectedAutomationRunPageId(null)
            setSelectedExternalRunPage(null)
            setActivePaneTab('overview')
          }}
        />
      ) : (
        <AutomationsPageListPanel
          controller={controller}
          onOpenDetail={() => setIsDetailOpen(true)}
        />
      )}
    </main>
  )
}

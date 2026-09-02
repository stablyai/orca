import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { AutomationDeleteDialog, ExternalAutomationDeleteDialog } from './AutomationDeleteDialogs'
import { AutomationEditorDialog } from './AutomationEditorDialog'
import { AutomationOwnerConflictNotice } from './AutomationOwnerConflictNotice'
import { AutomationsDetailPane } from './AutomationsDetailPane'
import { AutomationsListPanel } from './AutomationsListPanel'
import { AutomationsPageSkeleton } from './AutomationsPageSkeleton'
import { getAutomationAuthorityTarget } from './automation-host-client'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import type { AutomationsPageController } from './use-automations-page-controller'

/** Renders the page from controller state; host/query side effects stay in hooks. */
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
    destinationForm,
    setup,
    runPage,
    sourceAvailability,
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
    sshConnectionStates,
    runtimeStatusByEnvironmentId,
    repoForRow,
    worktreeForRow
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
    listSearchQuery,
    setListSearchQuery,
    listFilter,
    setListFilter,
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
    isLoading
  } = local
  const {
    hostCatalog,
    hasListItems,
    hasFilteredListItems,
    isListSearchQueryTooLarge,
    filteredRows,
    filteredExternalAutomationEntries,
    selected,
    selectedRow,
    selectedExternal,
    searchCounts
  } = list

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
  const onListFilterChange = (next: typeof listFilter): void => {
    setListFilter(next)
    if ((next.hostStableKeys?.length ?? 0) > 0 && hostCatalog.resolution.effective.kind !== 'all') {
      // Host narrowing now lives in the Filters menu; clear the old single-host scope.
      hostCatalog.selectHost({ kind: 'all' })
    }
  }

  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background pt-5 text-foreground md:pt-6">
      <header
        className="flex shrink-0 items-center px-3 pb-3 md:px-5"
        style={{ paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))' }}
      >
        <h1 className="truncate text-base font-semibold leading-8">
          {translate('auto.components.automations.AutomationsPage.77c2778945', 'Automations')}
        </h1>
      </header>

      <AutomationOwnerConflictNotice
        notice={ownerAction?.notice ?? null}
        className="mx-4 mb-2"
        onRecover={(action) => recoverOwnerAction(action)}
        onDismiss={() => setOwnerAction(null)}
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

      <AutomationDeleteDialog
        deleteTarget={deleteTarget?.automation ?? null}
        dontAskDeleteAgain={dontAskDeleteAgain}
        confirmButtonRef={deleteConfirmButtonRef}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDontAskDeleteAgain(false)
          }
        }}
        onDontAskAgainToggle={() => setDontAskDeleteAgain((previous) => !previous)}
        onCancel={() => {
          setDeleteTarget(null)
          setDontAskDeleteAgain(false)
        }}
        onConfirm={() => void managementActions.confirmDeleteAutomation()}
      />

      <ExternalAutomationDeleteDialog
        externalDeleteTarget={externalDeleteTarget}
        confirmButtonRef={externalDeleteConfirmButtonRef}
        onOpenChange={(open) => {
          if (!open) {
            setExternalDeleteTarget(null)
          }
        }}
        onCancel={() => setExternalDeleteTarget(null)}
        onConfirm={() => void externalActions.confirmDeleteExternalAutomation()}
      />

      {isLoading && !hasListItems ? (
        <AutomationsPageSkeleton />
      ) : isDetailOpen && (selected || selectedExternal) ? (
        <AutomationsDetailPane
          selected={selected}
          selectedExternal={selectedExternal}
          selectedExternalRunPage={selectedExternalRunPage}
          selectedAutomationRunPage={setup.selectedAutomationRunPage}
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
          selectedAutomationRunPageWorkspaceDisplay={
            runPage.selectedAutomationRunPageWorkspaceDisplay
          }
          selectedAutomationRunPageViewState={runPage.selectedAutomationRunPageViewState}
          canRerunSelectedAutomationRunPage={runPage.canRerunSelectedAutomationRunPage}
          isSelectedAutomationRunPageRerunPending={runPage.isSelectedAutomationRunPageRerunPending}
          worktreeMap={selectedRunWorktreeMap}
          fetchExternalAutomationRuns={externalActions.fetchExternalAutomationRuns}
          onActivePaneTabChange={setActivePaneTab}
          onClearExternalRunPage={() => setSelectedExternalRunPage(null)}
          onClearAutomationRunPage={() => setSelectedAutomationRunPageId(null)}
          requestExternalAction={externalActions.requestExternalAction}
          openExternalRunPage={externalActions.openExternalRunPage}
          openEditExternalDialog={editorActions.openEditExternalDialog}
          runNow={() => runSelectedRowAction(runActions.runNow)}
          openEditDialog={() => runSelectedRowAction(editorActions.openEditDialog)}
          toggleAutomation={() => runSelectedRowAction(managementActions.toggleAutomation)}
          requestDeleteAutomation={() =>
            runSelectedRowAction(managementActions.requestDeleteAutomation)
          }
          rerunAutomationRun={(_automation, run) =>
            runSelectedRowAction((row) => runActions.rerunAutomationRun(row, run))
          }
          openRunWorkspace={openRunWorkspace}
          openAutomationRunPage={externalActions.openAutomationRunPage}
          onBackToList={() => {
            setIsDetailOpen(false)
            setSelectedAutomationRunPageId(null)
            setSelectedExternalRunPage(null)
            setActivePaneTab('overview')
          }}
        />
      ) : (
        <AutomationsListPanel
          hasListItems={hasListItems}
          hasFilteredListItems={hasFilteredListItems}
          listSearchQuery={listSearchQuery}
          isListSearchQueryTooLarge={isListSearchQueryTooLarge}
          onListSearchQueryChange={setListSearchQuery}
          listFilter={listFilter}
          onListFilterChange={onListFilterChange}
          searchCounts={{
            ...searchCounts,
            hostRowCount: list.visibleRows.length + list.externalAutomationEntries.length
          }}
          hostCatalog={hostCatalog}
          externalManagersUncheckedNotice={list.externalManagersUncheckedNotice}
          onSelectHost={hostCatalog.selectHost}
          onRecoverHost={(action, entry) => {
            hostCatalog.recover(action, entry)
            if (action === 'retry') {
              void pageRefresh.refresh()
            }
          }}
          filteredRows={filteredRows}
          filteredExternalAutomationEntries={filteredExternalAutomationEntries}
          selectedRowKey={selectedRow?.key ?? null}
          selectedExternalKey={local.selectedExternalKey}
          selectedExternal={selectedExternal}
          relativeNow={relativeNow}
          repoMap={repoMap}
          worktreeMap={worktreeMap}
          repoForRow={repoForRow}
          worktreeForRow={worktreeForRow}
          projectHostSetups={projectHostSetups}
          sshConnectionStates={sshConnectionStates}
          runtimeStatusByEnvironmentId={runtimeStatusByEnvironmentId}
          hostTargetFor={destination.automationHostTargetFor}
          automationSourceHostAvailabilityByRowKey={
            sourceAvailability.automationSourceHostAvailabilityByRowKey
          }
          hostLabelById={presentation.hostLabelById}
          isActionEnabled={destination.isAutomationRowActionEnabled}
          externalActionKey={externalActionKey}
          selectAutomationRow={list.selectAutomationRow}
          selectExternalKey={local.selectExternalKey}
          setActivePaneTab={setActivePaneTab}
          runNow={(row) => void runActions.runNow(row)}
          openEditDialog={(row) => void editorActions.openEditDialog(row)}
          toggleAutomation={(row) => void managementActions.toggleAutomation(row)}
          requestDeleteAutomation={managementActions.requestDeleteAutomation}
          requestExternalAction={externalActions.requestExternalAction}
          openEditExternalDialog={editorActions.openEditExternalDialog}
          openCreateDialog={editorActions.openCreateDialog}
          canCreateAutomation={destination.canCreateAutomation}
          onOpenDetail={() => setIsDetailOpen(true)}
          onRefresh={() => {
            hostCatalog.refreshHosts()
            void pageRefresh.refresh()
          }}
          isRefreshing={isLoading}
        />
      )}
    </main>
  )
}

import { Plus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  RailPageHeader,
  RailPagePrimaryButton,
  RailPageRefreshButton
} from '@/components/rail-page/RailPageHeader'
import React from 'react'
import type { AutomationsPageController } from './use-automations-page-controller'
import { AutomationsListPanel } from './listing/AutomationsListPanel'
import { AutomationsPageSkeleton } from './AutomationsPageSkeleton'
import { nextAutomationListSort } from './listing/automation-list-view'

export function AutomationsPageListPanel({
  loadingList,
  title,
  count,
  tabs,
  notice,
  controller,
  onOpenDetail
}: {
  loadingList: boolean
  title: string
  count: number | null
  tabs: React.ReactNode
  notice: React.ReactNode
  controller: AutomationsPageController
  onOpenDetail: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const newAutomationLabel = t(
    'auto.components.automations.AutomationsPage.newAutomation',
    'New Automation'
  )
  const {
    store,
    local,
    list,
    destination,
    pageRefresh,
    runActions,
    editorActions,
    managementActions,
    externalActions,
    presentation
  } = controller
  const {
    projectHostSetups,
    repoMap,
    worktreeMap,
    sshConnectionStates,
    sshStateByEnvironment,
    runtimeStatusByEnvironmentId
  } = store
  const {
    listSearchQuery,
    setListSearchQuery,
    listFilter,
    setListFilter,
    relativeNow,
    externalActionKey,
    setActivePaneTab,
    isLoading
  } = local
  const {
    hostCatalog,
    hasListItems,
    hasFilteredListItems,
    isListSearchQueryTooLarge,
    selectedRow,
    searchCounts
  } = list
  const onListFilterChange = (next: typeof listFilter): void => {
    setListFilter(next)
    if ((next.hostStableKeys?.length ?? 0) > 0 && hostCatalog.resolution.effective.kind !== 'all') {
      hostCatalog.selectHost({ kind: 'all' })
    }
  }
  return (
    <>
      <RailPageHeader
        title={title}
        count={count}
        actions={
          loadingList ? undefined : (
            <>
              <RailPageRefreshButton
                label={t(
                  'auto.components.automations.AutomationsPage.19a6e30eae',
                  'Refresh automations'
                )}
                busy={isLoading}
                onRefresh={() => {
                  hostCatalog.refreshHosts()
                  void pageRefresh.refresh()
                }}
              />
              <RailPagePrimaryButton
                icon={<Plus className="size-3.5" />}
                label={newAutomationLabel}
                aria-label={newAutomationLabel}
                onClick={() => editorActions.openCreateDialog()}
                disabled={!destination.canCreateAutomation}
                data-contextual-tour-target="automations-create"
              />
            </>
          )
        }
      />
      {loadingList ? (
        <AutomationsPageSkeleton tabs={tabs} notice={notice} />
      ) : (
        <AutomationsListPanel
          tabs={tabs}
          notice={notice}
          hasListItems={hasListItems}
          hasFilteredListItems={hasFilteredListItems}
          listSearchQuery={listSearchQuery}
          isListSearchQueryTooLarge={isListSearchQueryTooLarge}
          onListSearchQueryChange={setListSearchQuery}
          listFilter={listFilter}
          onListFilterChange={onListFilterChange}
          searchCounts={searchCounts}
          hostCatalog={hostCatalog}
          externalManagersUncheckedNotice={list.externalManagersUncheckedNotice}
          onSelectHost={hostCatalog.selectHost}
          onRecoverHost={(action, entry) => {
            hostCatalog.recover(action, entry)
            if (action === 'retry') {
              void pageRefresh.refresh()
            }
          }}
          sortedListItems={list.sortedListItems}
          listSort={local.listSort}
          onListSortChange={(field) =>
            local.setListSort(nextAutomationListSort(local.listSort, field))
          }
          selectedRowKey={selectedRow?.key ?? null}
          selectedExternalKey={local.selectedExternalKey}
          relativeNow={relativeNow}
          repoMap={repoMap}
          worktreeMap={worktreeMap}
          repoForRow={store.repoForRow}
          worktreeForRow={store.worktreeForRow}
          projectHostSetups={projectHostSetups}
          sshConnectionStates={sshConnectionStates}
          sshStateByEnvironment={sshStateByEnvironment}
          runtimeStatusByEnvironmentId={runtimeStatusByEnvironmentId}
          hostTargetFor={destination.automationHostTargetFor}
          hostLabelById={presentation.hostLabelById}
          isActionEnabled={destination.isAutomationRowActionEnabled}
          needsMigration={(row) => !!destination.rowRecoveryHost(row.key)?.servedBy}
          externalActionKey={externalActionKey}
          selectAutomationRow={list.selectAutomationRow}
          selectExternalKey={local.selectExternalKey}
          setActivePaneTab={setActivePaneTab}
          runNow={(row) => void runActions.runNow(row)}
          openEditDialog={(row) => void editorActions.openEditDialog(row)}
          toggleAutomation={(row) => void managementActions.toggleAutomation(row)}
          reviewSkippedSetup={managementActions.reviewSkippedSetup}
          requestDeleteAutomation={managementActions.requestDeleteAutomation}
          requestExternalAction={externalActions.requestExternalAction}
          openCreateDialog={editorActions.openCreateDialog}
          onOpenDetail={onOpenDetail}
        />
      )}
    </>
  )
}

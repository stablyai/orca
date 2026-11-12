import React, { useMemo, useRef } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { resolveAutomationRunTarget } from './runs/automation-run-open-target'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { AutomationsPageEditorDialog } from './AutomationsPageEditorDialog'
import { AutomationsDetailPane } from './details/AutomationsDetailPane'
import { AutomationsPageSkeleton } from './AutomationsPageSkeleton'
import {
  automationProjectName,
  type AutomationListRow
} from './listing/automation-list-row-identity'
import { AutomationOwnerConflictNotice } from './hosts/AutomationOwnerConflictNotice'
import type { AutomationsPageController } from './use-automations-page-controller'
import { AutomationRunsDashboardSurface } from './runs/AutomationRunsDashboardSurface'
import { AutomationRunDetailsPage } from './runs/AutomationRunDetailsPage'
import { AutomationRunNotFound } from './runs/AutomationRunNotFound'
import { AutomationsPageDeleteDialogs } from './AutomationsPageDeleteDialogs'
import { AutomationsPageListPanel } from './AutomationsPageListPanel'
import {
  AutomationsPageBreadcrumb,
  AutomationsPageTabs,
  type AutomationsCrumb
} from './AutomationsPageBreadcrumb'
import { AutomationsPageFrame, AutomationsPageNoticeContext } from './AutomationsPageFrame'
import { useAutomationsPageRouting } from './use-automations-page-routing'
import { formatAutomationRunLabel } from './runs/automation-run-identity-label'
import { automationRowHostLabel } from './listing/automation-list-host'

export function AutomationsPageSurface({
  controller
}: {
  controller: AutomationsPageController
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const mainRef = useRef<HTMLElement>(null)
  const {
    store,
    local,
    list,
    destination,
    runsDashboard,
    setup,
    runPage,
    presentation,
    pageRefresh,
    editorActions,
    migrateAction,
    managementActions,
    runActions,
    externalActions,
    openRunWorkspace,
    navigation
  } = controller
  const { repoMap, setPendingAutomationRunNavigation } = store
  const {
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
    setSelectedAutomationRunPageId,
    setSelectedAutomationRuns,
    setRunHistoryReloadToken,
    isDetailOpen,
    setIsDetailOpen,
    ownerAction,
    setOwnerAction,
    isLoading,
    pageView,
    setPageView,
    runNotFound
  } = local
  const { hostCatalog, hasListItems, selected, selectedRow, selectedExternal } = list
  const selectedAutomationRunPage = setup.selectedAutomationRunPage
  const selectedRunWorktreeMap = new Map(
    setup.selectedRuns.flatMap((run) => {
      const worktree = list.runTargetFor(run).worktree
      return worktree ? [[run.id, worktree] as const] : []
    })
  )
  const runSelectedRowAction = (action: (row: AutomationListRow) => void): void => {
    if (selectedRow) {
      action(selectedRow)
    }
  }
  const { isRunNowPending } = useAutomationsPageRouting(controller, mainRef)
  const ownerNotice = useMemo(
    () =>
      ownerAction?.notice ? (
        <AutomationOwnerConflictNotice
          notice={ownerAction.notice}
          className="mt-3"
          onRecover={(action) => {
            setOwnerAction(null)
            hostCatalog.recover(action, ownerAction.host)
            if (action === 'retry') {
              void pageRefresh.refresh()
            }
          }}
          onDismiss={() => setOwnerAction(null)}
        />
      ) : null,
    [hostCatalog, ownerAction, pageRefresh, setOwnerAction]
  )

  const rootCrumb: AutomationsCrumb = {
    key: 'root',
    label: t('auto.components.automations.AutomationsPage.77c2778945', 'Automations'),
    onSelect: navigation.showList
  }
  const automationCrumb = (current: boolean): AutomationsCrumb | null =>
    selected
      ? {
          key: 'automation',
          label: selected.name,
          onSelect: current ? undefined : () => navigation.showSelectedAutomation()
        }
      : null
  const crumbs = (...items: (AutomationsCrumb | null)[]): React.ReactNode => (
    <AutomationsPageBreadcrumb
      items={items.filter((item): item is AutomationsCrumb => item !== null)}
    />
  )
  const automationCount = isLoading
    ? null
    : list.visibleRows.length + list.externalAutomationEntries.length
  const tabs = (current: 'automations' | 'runs'): React.ReactNode => (
    <AutomationsPageTabs
      current={current}
      automationCount={automationCount}
      onShowAutomations={navigation.showList}
      onShowRuns={() => {
        hostCatalog.selectHost({ kind: 'all' })
        navigation.showRuns()
      }}
    />
  )
  const selectedHostLabel = selectedRow
    ? automationRowHostLabel(selectedRow, store.repoForRow(selectedRow), presentation.hostLabelById)
    : ''
  const selectedRecoveryHost = destination.rowRecoveryHost(selectedRow?.key ?? null)
  const canSignIn =
    selectedRecoveryHost !== null &&
    (selectedRecoveryHost.stableRef.selector.kind === 'ssh' ||
      selectedRecoveryHost.stableRef.authority.kind === 'runtime')

  const renderPage = (): React.ReactNode => {
    if (pageView === 'runs') {
      return (
        <AutomationsPageFrame nav={tabs('runs')} bodyScroll="content">
          <AutomationRunsDashboardSurface
            rows={list.visibleRows}
            entries={runsDashboard.entries}
            failures={runsDashboard.failures}
            loading={runsDashboard.loading}
            hasMore={runsDashboard.hasMore}
            onLoadMore={runsDashboard.loadMore}
            now={relativeNow}
            onRefresh={() => setRunHistoryReloadToken((token) => token + 1)}
            worktreeForRun={(entry) =>
              resolveAutomationRunTarget(
                useAppStore.getState(),
                entry.run,
                destination.automationAuthorityForRow(entry.row)
              ).worktree
            }
            setPageView={setPageView}
            selectAutomationRow={list.selectAutomationRow}
            setPendingAutomationRunNavigation={setPendingAutomationRunNavigation}
            setIsDetailOpen={setIsDetailOpen}
          />
        </AutomationsPageFrame>
      )
    }
    if (pageView === 'run' && runNotFound) {
      const automationName = runNotFound.kind === 'run' ? (selected?.name ?? null) : null
      return (
        <AutomationRunNotFound
          nav={crumbs(rootCrumb, runNotFound.kind === 'run' ? automationCrumb(false) : null, {
            key: 'not-found',
            label:
              runNotFound.kind === 'run'
                ? t('auto.components.automations.runNotFound.crumbRun', 'Run not found')
                : t(
                    'auto.components.automations.runNotFound.crumbAutomation',
                    'Automation not found'
                  )
          })}
          notFound={runNotFound}
          automationName={automationName}
          onShowAutomations={navigation.showList}
          onShowAutomation={() => navigation.showSelectedAutomation()}
        />
      )
    }
    if (pageView === 'run' && store.pendingAutomationRunNavigation?.runId) {
      return (
        <AutomationsPageFrame nav={crumbs(rootCrumb)}>
          <div
            role="status"
            className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
          >
            <LoadingSpinner className="size-4" />
            {t('auto.components.automations.AutomationRunsDashboard.loading', 'Loading runs…')}
          </div>
        </AutomationsPageFrame>
      )
    }
    if (pageView === 'run' && selectedAutomationRunPage) {
      return (
        <AutomationRunDetailsPage
          nav={crumbs(rootCrumb, automationCrumb(false), {
            key: 'run',
            label: formatAutomationRunLabel(selectedAutomationRunPage, t, intlLocale)
          })}
          automation={selected}
          run={selectedAutomationRunPage}
          runs={setup.selectedRuns}
          history={local.selectedAutomationRuns}
          relativeNow={relativeNow}
          hostLabel={selectedHostLabel}
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
          onSignIn={
            canSignIn ? () => hostCatalog.recover('reconnect', selectedRecoveryHost) : undefined
          }
          onReviewSetup={(content) =>
            runSelectedRowAction((row) => managementActions.reviewSkippedSetup(row, content))
          }
          onSelectRun={(run) => setSelectedAutomationRunPageId(run.id)}
        />
      )
    }
    if (pageView === 'run' || (isLoading && !hasListItems)) {
      return (
        <AutomationsPageFrame nav={tabs('automations')} bodyScroll="content">
          <AutomationsPageSkeleton />
        </AutomationsPageFrame>
      )
    }
    if (isDetailOpen && (selected || selectedExternal)) {
      const nav = selectedExternal
        ? crumbs(rootCrumb, { key: 'external', label: selectedExternal.job.name })
        : activePaneTab === 'runs'
          ? crumbs(rootCrumb, automationCrumb(false), {
              key: 'runs',
              label: t('auto.components.automations.AutomationsPage.0e110a3469', 'Runs')
            })
          : crumbs(rootCrumb, automationCrumb(true))
      return (
        <AutomationsDetailPane
          nav={nav}
          selected={selected}
          selectedExternal={selectedExternal}
          selectedRuns={setup.selectedRuns}
          selectedRunsNotice={setup.selectedRunsNotice}
          selectedHostEntry={selectedRecoveryHost}
          recoverSelectedRuns={(action) => {
            hostCatalog.recover(action, selectedRecoveryHost)
            setSelectedAutomationRuns((current) => ({ ...current, notice: null }))
            setRunHistoryReloadToken((token) => token + 1)
          }}
          activePaneTab={activePaneTab}
          relativeNow={relativeNow}
          externalActionKey={externalActionKey}
          selectedRepoDisplayName={
            (selected &&
              automationProjectName(
                selected,
                presentation.selectedRepo,
                repoMap,
                !!selectedRecoveryHost?.servedBy
              )) ??
            t('auto.components.automations.AutomationsPage.13118faadf', 'Unknown project')
          }
          selectedRepoDefaultBaseRef={presentation.selectedRepo?.worktreeBaseRef ?? null}
          selectedWorkspaceName={
            selected?.workspaceMode === 'new_per_run'
              ? t(
                  'auto.components.automations.AutomationsPage.cd8397cc32',
                  'New workspace each run'
                )
              : (presentation.selectedWorktree?.displayName ??
                t(
                  'auto.components.automations.AutomationsPage.missingWorkspace',
                  'Missing workspace'
                ))
          }
          hostLabelById={presentation.hostLabelById}
          selectedRunNowAvailability={presentation.selectedRunNowAvailability}
          isRunNowPending={isRunNowPending}
          worktreeMap={selectedRunWorktreeMap}
          requestExternalAction={externalActions.requestExternalAction}
          runNow={() => runSelectedRowAction(runActions.runNow)}
          openEditDialog={() => runSelectedRowAction(editorActions.openEditDialog)}
          migrateAutomation={() => runSelectedRowAction(migrateAction.migrateAutomation)}
          isMigrating={!!selectedRow && migrateAction.migratingRowKey === selectedRow.key}
          toggleAutomation={() => runSelectedRowAction(managementActions.toggleAutomation)}
          requestDeleteAutomation={() =>
            runSelectedRowAction(managementActions.requestDeleteAutomation)
          }
          openAutomationRunPage={navigation.openSelectedAutomationRun}
          showAllRuns={() => navigation.showSelectedAutomation('runs')}
        />
      )
    }
    return (
      <AutomationsPageFrame
        nav={tabs('automations')}
        bodyScroll="content"
        actions={() => (
          <Button
            type="button"
            size="sm"
            onClick={() => editorActions.openCreateDialog()}
            disabled={!destination.canCreateAutomation}
            data-contextual-tour-target="automations-create"
          >
            <Plus className="size-4" />
            {t('auto.components.automations.AutomationsPage.newAutomation', 'New Automation')}
          </Button>
        )}
      >
        <AutomationsPageListPanel
          controller={controller}
          onOpenDetail={() => setIsDetailOpen(true)}
        />
      </AutomationsPageFrame>
    )
  }

  return (
    <main
      ref={mainRef}
      className="relative flex h-full min-h-0 flex-col bg-background pt-2 text-foreground"
    >
      <AutomationsPageEditorDialog controller={controller} />
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
      <AutomationsPageNoticeContext.Provider value={ownerNotice}>
        {renderPage()}
      </AutomationsPageNoticeContext.Provider>
    </main>
  )
}

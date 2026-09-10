import React from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type {
  Automation,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun,
  AutomationRun
} from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { AutomationDetail } from './AutomationDetail'
import { HermesCronOutputView } from './HermesCronOutputView'
import { AutomationRunPageFrame } from './AutomationRunPageFrame'
import { AutomationRunHistory } from './AutomationRunHistory'
import { ExternalAutomationManagers } from './ExternalAutomationManagers'
import type { FetchExternalAutomationRuns } from './ExternalAutomationRunTable'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import {
  formatExternalDate,
  getExternalProviderLabel,
  getExternalRunContent,
  getExternalRunStatusLabel,
  getExternalRunStatusVariant
} from './external-automation-display'
import type { AutomationActionNotice } from './automation-row-action-dispatch'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationTargetAvailability } from './automation-target-availability'
import type { AutomationPaneTab, SelectedExternalRunPage } from './automation-page-state'
import {
  getAutomationDetailNextTab,
  shouldHandleAutomationDetailEscapeKey,
  shouldHandleAutomationDetailTabArrowKey
} from './automation-detail-tab-navigation'
import { translate } from '@/i18n/i18n'

type AutomationsDetailPaneProps = {
  selected: Automation | null
  selectedExternal: ExternalAutomationListEntry | null
  selectedExternalRunPage: SelectedExternalRunPage | null
  selectedRuns: AutomationRun[]
  /** Set when the selected automation's history read failed; its runs are unknown. */
  selectedRunsNotice: AutomationActionNotice | null
  activePaneTab: AutomationPaneTab
  relativeNow: number
  externalActionKey: string | null
  selectedRepoDisplayName: string
  selectedRepoDefaultBaseRef: string | null
  selectedWorkspaceName: string
  /** Catalog entry the selected row was listed from; absent for legacy unscoped rows. */
  selectedHostEntry: AutomationHostCatalogEntry | null
  hostLabelById: ReadonlyMap<string, string>
  selectedRunNowAvailability: AutomationTargetAvailability | null
  worktreeMap: ReadonlyMap<string, Worktree>
  fetchExternalAutomationRuns: FetchExternalAutomationRuns
  onActivePaneTabChange: (tab: AutomationPaneTab) => void
  onClearExternalRunPage: () => void
  requestExternalAction: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction,
    scope: ExternalAutomationScope
  ) => void
  openExternalRunPage: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    run: ExternalAutomationRun
  ) => void
  openEditExternalDialog: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    scope: ExternalAutomationScope
  ) => void
  runNow: (automation: Automation) => void
  openEditDialog: (automation: Automation) => void
  toggleAutomation: (automation: Automation) => void
  requestDeleteAutomation: (automation: Automation) => void
  openAutomationRunPage: (run: AutomationRun) => void
  onBackToList: () => void
  recoverSelectedRuns: (action: AutomationHostRecoveryAction) => void
}

export function AutomationsDetailPane({
  selected,
  selectedExternal,
  selectedExternalRunPage,
  selectedRuns,
  selectedRunsNotice,
  activePaneTab,
  relativeNow,
  externalActionKey,
  selectedRepoDisplayName,
  selectedRepoDefaultBaseRef,
  selectedWorkspaceName,
  selectedHostEntry,
  hostLabelById,
  selectedRunNowAvailability,
  worktreeMap,
  fetchExternalAutomationRuns,
  onActivePaneTabChange,
  onClearExternalRunPage,
  requestExternalAction,
  openExternalRunPage,
  openEditExternalDialog,
  runNow,
  openEditDialog,
  toggleAutomation,
  requestDeleteAutomation,
  openAutomationRunPage,
  onBackToList,
  recoverSelectedRuns
}: AutomationsDetailPaneProps): React.JSX.Element {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (shouldHandleAutomationDetailEscapeKey(event)) {
        event.preventDefault()
        if (selectedExternalRunPage) {
          onClearExternalRunPage()
          return
        }
        onBackToList()
        return
      }

      if (selectedExternal || !selected) {
        return
      }

      if (shouldHandleAutomationDetailTabArrowKey(event)) {
        const nextTab = getAutomationDetailNextTab({
          currentTab: activePaneTab,
          key: event.key as 'ArrowLeft' | 'ArrowRight',
          canAccessRuns: Boolean(selected)
        })
        if (nextTab && nextTab !== activePaneTab) {
          event.preventDefault()
          onActivePaneTabChange(nextTab)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    activePaneTab,
    onActivePaneTabChange,
    onBackToList,
    onClearExternalRunPage,
    selected,
    selectedExternal,
    selectedExternalRunPage
  ])

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {selectedExternal ? (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-5">
          <div className="mb-3">
            <Button type="button" variant="ghost" size="sm" onClick={onBackToList}>
              <ArrowLeft className="size-4" />
              {translate(
                'auto.components.automations.AutomationsPage.backToList',
                'All automations'
              )}
            </Button>
          </div>
          {selectedExternalRunPage ? (
            <AutomationRunPageFrame
              title={selectedExternalRunPage.job.name}
              breadcrumbs={[
                formatExternalDate(selectedExternalRunPage.run.runAt, relativeNow),
                getExternalProviderLabel(selectedExternalRunPage.manager),
                selectedExternalRunPage.manager.targetLabel
              ]}
              detail={selectedExternalRunPage.run.outputPath}
              statusLabel={getExternalRunStatusLabel(selectedExternalRunPage.run)}
              statusVariant={getExternalRunStatusVariant(selectedExternalRunPage.run)}
              onBack={onClearExternalRunPage}
            >
              <HermesCronOutputView content={getExternalRunContent(selectedExternalRunPage.run)} />
            </AutomationRunPageFrame>
          ) : (
            <ExternalAutomationManagers
              managers={[
                {
                  // The synthesized single-job manager keeps the entry's scope, so
                  // every action it dispatches names the host the row came from.
                  scope: selectedExternal.scope,
                  manager: {
                    ...selectedExternal.manager,
                    jobs: [selectedExternal.job]
                  }
                }
              ]}
              now={relativeNow}
              runningActionKey={externalActionKey}
              onAction={requestExternalAction}
              onFetchRuns={fetchExternalAutomationRuns}
              onOpenRun={openExternalRunPage}
              onEdit={openEditExternalDialog}
            />
          )}
        </div>
      ) : (
        <Tabs
          value={activePaneTab}
          onValueChange={(value) => onActivePaneTabChange(value as AutomationPaneTab)}
          className="min-h-0 flex-1 gap-0"
        >
          <div
            className="flex shrink-0 items-center gap-2 border-b border-border/50 px-5 py-2"
            data-contextual-tour-target="automations-runs"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onBackToList}
              aria-label={translate(
                'auto.components.automations.AutomationsPage.backToList',
                'All automations'
              )}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <TabsList variant="line" className="h-8">
              <TabsTrigger value="overview">
                {translate('auto.components.automations.AutomationsPage.bb1b2cd31e', 'Overview')}
              </TabsTrigger>
              <TabsTrigger value="runs" disabled={!selected}>
                {translate('auto.components.automations.AutomationsPage.0e110a3469', 'Runs')}{' '}
                {selectedRunsNotice ? null : (
                  <span className="text-xs text-muted-foreground">{selectedRuns.length}</span>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="scrollbar-sleek min-h-0 overflow-auto p-5">
            <AutomationDetail
              automation={selected}
              runs={selectedRuns}
              projectName={selectedRepoDisplayName}
              projectDefaultBaseRef={selectedRepoDefaultBaseRef}
              workspaceName={selectedWorkspaceName}
              hostEntry={selectedHostEntry}
              hostLabelById={hostLabelById}
              runNowAvailability={selectedRunNowAvailability}
              now={relativeNow}
              onRunNow={(automation) => void runNow(automation)}
              onEdit={(automation) => void openEditDialog(automation)}
              onToggle={(automation) => void toggleAutomation(automation)}
              onDelete={requestDeleteAutomation}
            />
          </TabsContent>

          <TabsContent value="runs" className="scrollbar-sleek min-h-0 overflow-auto p-5">
            {selected ? (
              <AutomationRunHistory
                runs={selectedRuns}
                automationId={selected.id}
                worktreeMap={worktreeMap}
                notice={selectedRunsNotice}
                onRecoverHistory={recoverSelectedRuns}
                onOpenRun={openAutomationRunPage}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {translate(
                  'auto.components.automations.AutomationsPage.c3a28c9793',
                  'Select an automation to view runs.'
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </section>
  )
}

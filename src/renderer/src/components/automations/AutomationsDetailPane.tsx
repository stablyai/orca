import React from 'react'
import { ArrowLeft, Eye, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type {
  Automation,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun,
  AutomationRun
} from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/worktree/types'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { AutomationDetail } from './AutomationDetail'
import { HermesCronOutputView } from './HermesCronOutputView'
import { AutomationRunPageFrame } from './AutomationRunPageFrame'
import { AutomationRunHistory } from './AutomationRunHistory'
import { ExternalAutomationManagers } from './ExternalAutomationManagers'
import type { FetchExternalAutomationRuns } from './ExternalAutomationRunTable'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import {
  formatExternalDate,
  getExternalProviderLabel,
  getExternalRunContent,
  getExternalRunStatusLabel,
  getExternalRunStatusVariant
} from './external-automation-display'
import {
  formatAutomationDateTimeWithRelative,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from './automation-page-parts'
import { getAutomationRunContent } from './automation-run-content'
import type { AutomationTargetAvailability } from './automation-target-availability'
import type { AutomationRunViewState } from './automation-run-view-state'
import type { AutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import type { AutomationPaneTab, SelectedExternalRunPage } from './automation-page-state'
import { translate } from '@/i18n/i18n'

type AutomationsDetailPaneProps = {
  selected: Automation | null
  selectedExternal: ExternalAutomationListEntry | null
  selectedExternalRunPage: SelectedExternalRunPage | null
  selectedAutomationRunPage: AutomationRun | null
  selectedRuns: AutomationRun[]
  activePaneTab: AutomationPaneTab
  relativeNow: number
  externalActionKey: string | null
  selectedRepoDisplayName: string
  selectedRepoDefaultBaseRef: string | null
  selectedWorkspaceName: string
  hostLabelById: ReadonlyMap<string, string>
  selectedRunNowAvailability: AutomationTargetAvailability | null
  selectedAutomationRunPageWorkspaceDisplay: AutomationRunWorkspaceDisplay | null
  selectedAutomationRunPageViewState: AutomationRunViewState | null
  canRerunSelectedAutomationRunPage: boolean
  isSelectedAutomationRunPageRerunPending: boolean
  worktreeMap: ReadonlyMap<string, Worktree>
  fetchExternalAutomationRuns: FetchExternalAutomationRuns
  onActivePaneTabChange: (tab: AutomationPaneTab) => void
  onClearExternalRunPage: () => void
  onClearAutomationRunPage: () => void
  requestExternalAction: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ) => void
  openExternalRunPage: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    run: ExternalAutomationRun
  ) => void
  openEditExternalDialog: (manager: ExternalAutomationManager, job: ExternalAutomationJob) => void
  runNow: (automation: Automation) => void
  openEditDialog: (automation: Automation) => void
  toggleAutomation: (automation: Automation) => void
  requestDeleteAutomation: (automation: Automation) => void
  rerunAutomationRun: (automation: Automation, run: AutomationRun) => void
  openRunWorkspace: (run: AutomationRun) => void
  openAutomationRunPage: (run: AutomationRun) => void
  onBackToList: () => void
}

export function AutomationsDetailPane({
  selected,
  selectedExternal,
  selectedExternalRunPage,
  selectedAutomationRunPage,
  selectedRuns,
  activePaneTab,
  relativeNow,
  externalActionKey,
  selectedRepoDisplayName,
  selectedRepoDefaultBaseRef,
  selectedWorkspaceName,
  hostLabelById,
  selectedRunNowAvailability,
  selectedAutomationRunPageWorkspaceDisplay,
  selectedAutomationRunPageViewState,
  canRerunSelectedAutomationRunPage,
  isSelectedAutomationRunPageRerunPending,
  worktreeMap,
  fetchExternalAutomationRuns,
  onActivePaneTabChange,
  onClearExternalRunPage,
  onClearAutomationRunPage,
  requestExternalAction,
  openExternalRunPage,
  openEditExternalDialog,
  runNow,
  openEditDialog,
  toggleAutomation,
  requestDeleteAutomation,
  rerunAutomationRun,
  openRunWorkspace,
  openAutomationRunPage,
  onBackToList
}: AutomationsDetailPaneProps): React.JSX.Element {
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
                  ...selectedExternal.manager,
                  jobs: [selectedExternal.job]
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
                <span className="text-xs text-muted-foreground">{selectedRuns.length}</span>
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
            {selectedAutomationRunPage ? (
              <AutomationRunPageFrame
                title={selected?.name ?? selectedAutomationRunPage.title}
                breadcrumbs={[
                  formatAutomationDateTimeWithRelative(
                    selectedAutomationRunPage.scheduledFor,
                    relativeNow
                  ),
                  'Orca',
                  selectedAutomationRunPageWorkspaceDisplay?.detailLabel ??
                    translate(
                      'auto.components.automations.AutomationsPage.noWorkspace',
                      'No workspace'
                    )
                ]}
                detail={
                  selectedAutomationRunPage.outputSnapshot?.truncated
                    ? translate(
                        'auto.components.automations.AutomationsPage.latestSavedOutput',
                        'Latest saved output'
                      )
                    : null
                }
                statusLabel={getAutomationRunStatusLabel(selectedAutomationRunPage.status)}
                statusVariant={getAutomationRunStatusVariant(selectedAutomationRunPage.status)}
                actions={
                  <>
                    {canRerunSelectedAutomationRunPage && selected ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isSelectedAutomationRunPageRerunPending}
                        onClick={() => void rerunAutomationRun(selected, selectedAutomationRunPage)}
                      >
                        <RefreshCw
                          className={cn(
                            'size-3.5',
                            isSelectedAutomationRunPageRerunPending && 'animate-spin'
                          )}
                        />
                        {translate(
                          'auto.components.automations.AutomationsPage.295698292f',
                          'Rerun'
                        )}
                      </Button>
                    ) : null}
                    {selectedAutomationRunPageViewState ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!selectedAutomationRunPageViewState.canOpen}
                        onClick={() => openRunWorkspace(selectedAutomationRunPage)}
                      >
                        <Eye className="size-3.5" />
                        {selectedAutomationRunPageViewState.actionLabel}
                      </Button>
                    ) : null}
                  </>
                }
                onBack={onClearAutomationRunPage}
              >
                <CommentMarkdown
                  variant="document"
                  content={getAutomationRunContent(selectedAutomationRunPage)}
                  className="text-sm leading-relaxed text-foreground"
                />
              </AutomationRunPageFrame>
            ) : selected ? (
              <AutomationRunHistory
                runs={selectedRuns}
                automationId={selected.id}
                worktreeMap={worktreeMap}
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

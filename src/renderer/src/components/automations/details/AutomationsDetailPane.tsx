import React from 'react'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../../shared/automations/external/external-automation'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { Worktree } from '../../../../../shared/worktree/types'
import { AutomationDetail } from './AutomationDetail'
import { AutomationDetailActions } from './AutomationDetailActions'
import { AutomationRunHistory } from '../runs/AutomationRunHistory'
import { ExternalAutomationManagers } from '../external/ExternalAutomationManagers'
import type { ExternalAutomationListEntry } from '../external/external-automation-list-entries'
import type { ExternalAutomationScope } from '../external/external-automation-scope-client'
import type { AutomationActionNotice } from '../hosts/automation-row-action-dispatch'
import type { AutomationHostRecoveryAction } from '../hosts/automation-host-status-descriptors'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import type { AutomationTargetAvailability } from '../hosts/automation-target-availability-types'
import type { AutomationPaneTab, AutomationRunPageOrigin } from '../automation-page-state'
import { AutomationsPageFrame, AutomationsPageTitle } from '../AutomationsPageFrame'
import { useTranslate } from '@/i18n/use-translate'

type AutomationsDetailPaneProps = {
  /** Breadcrumb for the current sub-page, built by the page so every path agrees. */
  nav: React.ReactNode
  selected: Automation | null
  selectedExternal: ExternalAutomationListEntry | null
  selectedRuns: AutomationRun[]
  /** Set when the selected automation's history read failed; its runs are unknown. */
  selectedRunsNotice: AutomationActionNotice | null
  /** 'runs' shows the automation's full run history as its own page. */
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
  isRunNowPending: boolean
  worktreeMap: ReadonlyMap<string, Worktree>
  requestExternalAction: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction,
    scope: ExternalAutomationScope
  ) => void
  runNow: (automation: Automation) => void
  openEditDialog: (automation: Automation) => void
  migrateAutomation?: (automation: Automation) => void
  isMigrating?: boolean
  toggleAutomation: (automation: Automation) => void
  requestDeleteAutomation: (automation: Automation) => void
  openAutomationRunPage: (run: AutomationRun, origin: AutomationRunPageOrigin) => void
  showAllRuns: () => void
  recoverSelectedRuns: (action: AutomationHostRecoveryAction) => void
}

export function AutomationsDetailPane({
  nav,
  selected,
  selectedExternal,
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
  isRunNowPending,
  worktreeMap,
  requestExternalAction,
  runNow,
  openEditDialog,
  migrateAutomation,
  isMigrating,
  toggleAutomation,
  requestDeleteAutomation,
  openAutomationRunPage,
  showAllRuns,
  recoverSelectedRuns
}: AutomationsDetailPaneProps): React.JSX.Element {
  const t = useTranslate()

  if (selectedExternal) {
    return (
      <AutomationsPageFrame nav={nav}>
        <div className="flex flex-col gap-4 pt-5">
          <AutomationsPageTitle title={selectedExternal.job.name}>
            {selectedExternal.job.name}
          </AutomationsPageTitle>
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
          />
        </div>
      </AutomationsPageFrame>
    )
  }

  if (selected && activePaneTab === 'runs') {
    return (
      <AutomationsPageFrame nav={nav} bodyScroll="content">
        <div className="flex shrink-0 flex-col gap-1 pb-4 pt-5">
          <AutomationsPageTitle>
            {t('auto.components.automations.AutomationsPage.0e110a3469', 'Runs')}
          </AutomationsPageTitle>
          <p className="truncate text-sm text-muted-foreground" title={selected.name}>
            {selected.name}
          </p>
        </div>
        <AutomationRunHistory
          runs={selectedRuns}
          automationId={selected.id}
          worktreeMap={worktreeMap}
          notice={selectedRunsNotice}
          onRecoverHistory={recoverSelectedRuns}
          onOpenRun={(run) => openAutomationRunPage(run, 'automationRuns')}
        />
      </AutomationsPageFrame>
    )
  }

  return (
    <AutomationsPageFrame
      nav={nav}
      actions={
        selected
          ? ({ compact }) => (
              <AutomationDetailActions
                automation={selected}
                compact={compact}
                runNowAvailability={selectedRunNowAvailability}
                isRunNowPending={isRunNowPending}
                onRunNow={runNow}
                onEdit={openEditDialog}
                onToggle={toggleAutomation}
                onDelete={requestDeleteAutomation}
              />
            )
          : undefined
      }
    >
      <AutomationDetail
        automation={selected}
        runs={selectedRuns}
        runsNotice={selectedRunsNotice}
        onRecoverHistory={recoverSelectedRuns}
        onOpenRun={(run) => openAutomationRunPage(run, 'automation')}
        onShowAllRuns={showAllRuns}
        projectName={selectedRepoDisplayName}
        projectDefaultBaseRef={selectedRepoDefaultBaseRef}
        workspaceName={selectedWorkspaceName}
        hostEntry={selectedHostEntry}
        hostLabelById={hostLabelById}
        runNowAvailability={selectedRunNowAvailability}
        now={relativeNow}
        onMigrate={migrateAutomation}
        isMigrating={isMigrating}
      />
    </AutomationsPageFrame>
  )
}

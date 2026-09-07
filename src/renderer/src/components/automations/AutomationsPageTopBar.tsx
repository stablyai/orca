import React from 'react'
import { translate } from '@/i18n/i18n'
import { AutomationOwnerConflictNotice } from './AutomationOwnerConflictNotice'
import { AutomationsPageBreadcrumb } from './AutomationsPageBreadcrumb'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import type { AutomationActionNotice } from './automation-row-action-dispatch'

export function AutomationsPageTopBar({
  pageView,
  isDetailOpen,
  selectedAutomationName,
  runPageOrigin,
  ownerNotice,
  recoverOwnerAction,
  dismissOwnerAction,
  showAutomationsList,
  showRunsDashboard,
  showAutomationDetails
}: {
  pageView: 'automations' | 'runs' | 'run'
  isDetailOpen: boolean
  selectedAutomationName?: string
  runPageOrigin: 'automation' | 'runs'
  ownerNotice: AutomationActionNotice | null
  recoverOwnerAction: (action: AutomationHostRecoveryAction) => void
  dismissOwnerAction: () => void
  showAutomationsList: () => void
  showRunsDashboard: () => void
  showAutomationDetails: () => void
}): React.JSX.Element {
  return (
    <>
      <header
        className="flex shrink-0 items-center px-3 pb-3 md:px-5"
        style={{ paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))' }}
      >
        {pageView === 'runs' || pageView === 'run' ? (
          <AutomationsPageBreadcrumb
            current={pageView}
            onBackToAutomations={showAutomationsList}
            onBackToRuns={showRunsDashboard}
            automationName={runPageOrigin === 'automation' ? selectedAutomationName : undefined}
            onBackToAutomation={showAutomationDetails}
          />
        ) : isDetailOpen && selectedAutomationName ? (
          <AutomationsPageBreadcrumb
            current="automation"
            automationName={selectedAutomationName}
            onBackToAutomations={showAutomationsList}
          />
        ) : (
          <h1 className="truncate text-base font-semibold leading-8">
            {translate('auto.components.automations.AutomationsPage.77c2778945', 'Automations')}
          </h1>
        )}
      </header>
      <AutomationOwnerConflictNotice
        notice={ownerNotice}
        className="mx-4 mb-2"
        onRecover={recoverOwnerAction}
        onDismiss={dismissOwnerAction}
      />
    </>
  )
}

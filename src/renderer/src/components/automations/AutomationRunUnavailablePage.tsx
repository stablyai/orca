import type { JSX } from 'react'
import { translate } from '@/i18n/i18n'
import { AutomationOwnerConflictNotice } from './AutomationOwnerConflictNotice'
import { AutomationRunPageFrame } from './AutomationRunPageFrame'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import type { AutomationActionNotice } from './automation-row-action-dispatch'

export function AutomationRunUnavailablePage({
  automationName,
  notice,
  onRecover,
  onBack
}: {
  automationName?: string
  notice: AutomationActionNotice | null
  onRecover: (action: AutomationHostRecoveryAction) => void
  onBack: () => void
}): JSX.Element {
  return (
    <section className="flex min-h-0 flex-1 p-5">
      <AutomationRunPageFrame
        title={
          automationName ??
          translate(
            'auto.components.automations.AutomationsPageBreadcrumb.runDetails',
            'Run details'
          )
        }
        breadcrumbs={[]}
        onBack={onBack}
      >
        <AutomationOwnerConflictNotice
          notice={
            notice ?? {
              message: translate(
                'auto.components.automations.AutomationsPage.pendingAutomationRunMissing',
                'Run history no longer available.'
              ),
              recovery: null
            }
          }
          onRecover={onRecover}
        />
      </AutomationRunPageFrame>
    </section>
  )
}

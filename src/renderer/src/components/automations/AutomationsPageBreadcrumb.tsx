import React from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function AutomationsPageBreadcrumb({
  current,
  onBackToAutomations,
  onBackToRuns,
  automationName,
  onBackToAutomation
}: {
  current: 'runs' | 'run' | 'automation'
  onBackToAutomations: () => void
  onBackToRuns?: () => void
  automationName?: string
  onBackToAutomation?: () => void
}): React.JSX.Element {
  return (
    <nav
      aria-label={translate(
        'auto.components.automations.AutomationsPageBreadcrumb.ariaLabel',
        'Automations breadcrumb'
      )}
      className="flex min-w-0 items-center text-sm"
    >
      <Button
        type="button"
        variant="link"
        className="h-8 px-0 font-normal text-muted-foreground"
        onClick={onBackToAutomations}
      >
        {translate('auto.components.automations.AutomationsPage.77c2778945', 'Automations')}
      </Button>
      <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground" />
      {current === 'automation' ? (
        <span className="truncate font-medium" aria-current="page">
          {automationName}
        </span>
      ) : current === 'run' ? (
        <>
          {automationName ? (
            <Button
              type="button"
              variant="link"
              className="h-8 max-w-[28ch] truncate px-0 font-normal text-muted-foreground"
              onClick={onBackToAutomation}
            >
              {automationName}
            </Button>
          ) : (
            <Button
              type="button"
              variant="link"
              className="h-8 px-0 font-normal text-muted-foreground"
              onClick={onBackToRuns}
            >
              {translate('auto.components.automations.AutomationRunsDashboard.runs', 'Runs')}
            </Button>
          )}
          <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium" aria-current="page">
            {translate(
              'auto.components.automations.AutomationsPageBreadcrumb.runDetails',
              'Run details'
            )}
          </span>
        </>
      ) : (
        <span className="truncate font-medium" aria-current="page">
          {translate('auto.components.automations.AutomationRunsDashboard.runs', 'Runs')}
        </span>
      )}
    </nav>
  )
}

import React from 'react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import {
  formatAutomationRelativeTime,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from './automation-page-parts'
import type { AutomationLastRun } from './automation-last-run-lookup'

type AutomationLastRunBadgeProps = {
  lastRun: AutomationLastRun | null
  now: number
}

/** Compact last-run signal for a list row: status Badge + relative time. Reuses
 *  the run-status label/variant mapping so it reads identically to the run
 *  history and detail surfaces. */
export function AutomationLastRunBadge({
  lastRun,
  now
}: AutomationLastRunBadgeProps): React.JSX.Element {
  if (!lastRun) {
    return (
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.automations.AutomationLastRunBadge.noRuns', 'No runs yet')}
      </span>
    )
  }
  const relative = formatAutomationRelativeTime(lastRun.at, now)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Badge variant={getAutomationRunStatusVariant(lastRun.status)}>
        {getAutomationRunStatusLabel(lastRun.status)}
      </Badge>
      {relative ? <span className="truncate text-xs text-muted-foreground">{relative}</span> : null}
    </span>
  )
}

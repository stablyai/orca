import React from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/class-names'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { AutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import {
  formatAutomationDateTime,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from '../automation-page-parts'
import { formatAutomationCost } from './automation-usage-model'
import { formatAutomationRunLabel } from './automation-run-identity-label'
import type { AutomationRunWorkspaceDisplay } from './automation-run-workspace-display'

// Run | Result | Workspace | Spend — shared by an automation's history and the Runs page.
export const AUTOMATION_RUN_TABLE_GRID_CLASS =
  'grid w-full grid-cols-[minmax(9rem,1fr)_minmax(6rem,8rem)_minmax(8rem,1.2fr)_minmax(4rem,5rem)] gap-3'
// The Runs page adds the automation after the run.
export const AUTOMATION_RUNS_DASHBOARD_GRID_CLASS =
  'grid w-full grid-cols-[minmax(8rem,.8fr)_minmax(10rem,1.2fr)_minmax(6rem,8rem)_minmax(8rem,1fr)_minmax(4rem,5rem)] gap-3'

export function AutomationRunTableHeaderCells({
  withAutomation = false
}: {
  withAutomation?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <div>{t('auto.components.automations.AutomationRunHistory.8faaa00726', 'Run')}</div>
      {withAutomation ? (
        <div>
          {t('auto.components.automations.AutomationRunsDashboard.automation', 'Automation')}
        </div>
      ) : null}
      <div>{t('auto.components.automations.runTable.result', 'Result')}</div>
      <div>{t('auto.components.automations.AutomationRunHistory.149c0b49c7', 'Workspace')}</div>
      <div className="text-right">
        {t('auto.components.automations.AutomationRunHistory.86a248187e', 'Spend')}
      </div>
    </>
  )
}

export function AutomationRunIdentityCell({
  run,
  extra
}: {
  run: { runNumber?: number; scheduledFor: number }
  /** A further line, such as folded occurrences. */
  extra?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const hasNumber = typeof run.runNumber === 'number'
  return (
    <div className="min-w-0">
      <div className="truncate font-medium">{formatAutomationRunLabel(run, t, intlLocale)}</div>
      {hasNumber ? (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {formatAutomationDateTime(run.scheduledFor, t, intlLocale)}
        </div>
      ) : null}
      {extra}
    </div>
  )
}

export function AutomationRunResultCell({
  status
}: {
  status: AutomationRunStatus
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex min-w-0 justify-start">
      <Badge variant={getAutomationRunStatusVariant(status)}>
        {getAutomationRunStatusLabel(status, t)}
      </Badge>
    </div>
  )
}

export function AutomationRunWorkspaceCell({
  display
}: {
  display: AutomationRunWorkspaceDisplay
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'min-w-0 truncate',
        display.muted ? 'text-muted-foreground' : 'text-foreground'
      )}
      title={display.title}
    >
      {display.rowLabel}
    </div>
  )
}

export function AutomationRunSpendCell({
  estimatedCostUsd,
  usageKnown,
  title
}: {
  estimatedCostUsd: number | null | undefined
  usageKnown: boolean
  title?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className={cn(
        'text-right tabular-nums',
        usageKnown ? 'text-foreground' : 'text-muted-foreground'
      )}
      title={title}
    >
      {formatAutomationCost(estimatedCostUsd, t)}
    </div>
  )
}

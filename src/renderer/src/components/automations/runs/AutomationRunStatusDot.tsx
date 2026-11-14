import React from 'react'
import { cn } from '@/lib/class-names'
import type { AutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import { useTranslate } from '@/i18n/use-translate'
import { getToneForAutomationRunStatus } from '../listing/automation-list-last-run'
import { getAutomationRunStatusLabel } from '../automation-page-parts'

/** A run's outcome at a glance; the status word next to it carries the meaning. */
export function AutomationRunStatusDot({
  status,
  className
}: {
  status: AutomationRunStatus
  className?: string
}): React.JSX.Element {
  const tone = getToneForAutomationRunStatus(status)
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-2 shrink-0 rounded-full',
        tone === 'failed' && 'bg-destructive',
        tone === 'succeeded' && 'bg-status-success',
        tone === 'running' && 'animate-pulse bg-foreground motion-reduce:animate-none',
        (tone === 'skipped' || tone === 'unknown' || tone === 'never') &&
          'border-[1.5px] border-muted-foreground',
        className
      )}
    />
  )
}

/** Dot + status word, the one way run status is drawn; a failure reads in red. */
export function AutomationRunStatusLabel({
  status,
  pill = false,
  className
}: {
  status: AutomationRunStatus
  /** A soft-tinted pill for the run page header. */
  pill?: boolean
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const tone = getToneForAutomationRunStatus(status)
  return (
    <span
      className={cn(
        'inline-flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap',
        tone === 'failed' ? 'text-destructive' : pill ? 'text-foreground' : 'text-muted-foreground',
        pill && 'rounded-full px-2 py-0.5 text-xs font-medium',
        pill && (tone === 'failed' ? 'bg-destructive/10' : 'bg-muted'),
        className
      )}
    >
      <AutomationRunStatusDot status={status} />
      {getAutomationRunStatusLabel(status, t)}
    </span>
  )
}

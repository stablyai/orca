import React from 'react'
import { cn } from '@/lib/class-names'
import type { AutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import { getToneForAutomationRunStatus } from '../listing/automation-list-last-run'

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

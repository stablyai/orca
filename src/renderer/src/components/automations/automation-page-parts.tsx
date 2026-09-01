import React from 'react'
import type { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunLaunchFailure } from './automation-run-view-state'

export function formatAutomationDateTime(value: number | null | undefined): string {
  if (!value) {
    return 'Never'
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(value)
}

export function formatAutomationRelativeTime(
  value: number | null | undefined,
  now = Date.now()
): string | null {
  if (!value) {
    return null
  }
  const diffMs = value - now
  const absMs = Math.abs(diffMs)
  const minuteMs = 60 * 1000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  const format = (amount: number, unit: string): string => `${amount}${unit}`
  let text: string
  if (absMs < minuteMs) {
    text = 'now'
  } else if (absMs < hourMs) {
    text = format(Math.round(absMs / minuteMs), 'm')
  } else if (absMs < dayMs) {
    text = format(Math.round(absMs / hourMs), 'h')
  } else {
    text = format(Math.round(absMs / dayMs), 'd')
  }
  if (text === 'now') {
    return text
  }
  return diffMs >= 0 ? `in ${text}` : `${text} ago`
}

export function formatAutomationDateTimeWithRelative(
  value: number | null | undefined,
  now = Date.now()
): string {
  const absolute = formatAutomationDateTime(value)
  const relative = formatAutomationRelativeTime(value, now)
  return relative ? `${absolute} (${relative})` : absolute
}

export function getAutomationRunStatusVariant(
  status: AutomationRun['status']
): React.ComponentProps<typeof Badge>['variant'] {
  if (status === 'dispatched' || status === 'completed') {
    return 'secondary'
  }
  if (status.startsWith('skipped')) {
    return 'outline'
  }
  if (status === 'dispatch_failed') {
    return 'destructive'
  }
  return 'dot'
}

export function getAutomationRunStatusLabel(status: AutomationRun['status']): string {
  switch (status) {
    case 'pending':
      return 'Queued'
    case 'dispatching':
      return 'Starting'
    case 'dispatched':
      return 'Launched'
    case 'completed':
      return 'Done'
    case 'skipped_precheck':
      return 'Precheck skipped'
    case 'skipped_missed':
      return 'Skipped'
    case 'skipped_unavailable':
      return 'Unavailable'
    case 'skipped_needs_interactive_auth':
      return 'Needs credentials'
    case 'dispatch_failed':
      return 'Failed'
  }
}

export type AutomationRunRowBadge = {
  label: string
  variant: React.ComponentProps<typeof Badge>['variant']
}

/** Badge for a run history row. A run stranded mid-dispatch keeps a non-terminal
 *  status, so its default label ("Starting"/"Queued") would mask the recorded
 *  launch failure; surface the structured failed/forgotten state instead. */
export function getAutomationRunRowBadge(run: AutomationRun): AutomationRunRowBadge {
  const launchFailure = getAutomationRunLaunchFailure(run)
  if (launchFailure && (run.status === 'dispatching' || run.status === 'pending')) {
    if (launchFailure.forgottenAt !== null) {
      return {
        label: translate('agentLaunch.unattendedFailure.rowBadge.forgotten', 'Forgotten'),
        variant: 'outline'
      }
    }
    return {
      label: translate('agentLaunch.unattendedFailure.rowBadge.didNotStart', "Didn't start"),
      variant: 'destructive'
    }
  }
  return {
    label: getAutomationRunStatusLabel(run.status),
    variant: getAutomationRunStatusVariant(run.status)
  }
}

export function Field({
  label,
  children,
  className,
  labelClassName
}: {
  label: React.ReactNode
  children: React.ReactNode
  className?: string
  labelClassName?: string
}): React.JSX.Element {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <div className={cn('text-xs text-muted-foreground', labelClassName)}>{label}</div>
      {children}
    </div>
  )
}

export const AUTOMATION_EDITOR_SECTION_LABEL_CLASS = 'font-medium text-foreground'

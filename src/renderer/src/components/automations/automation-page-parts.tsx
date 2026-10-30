import React from 'react'
import type { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AutomationRun } from '../../../../shared/automations-types'
import { translate } from '@/i18n/i18n'
import { formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'

// Reuse one formatter across run cells; per-cell construction dominates large-history rendering.
const AUTOMATION_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}

export function formatAutomationDateTime(value: number | null | undefined): string {
  if (!value) {
    return translate('auto.components.automations.automationPageParts.never', 'Never')
  }
  return uiDateTimeFormat(AUTOMATION_DATE_TIME_OPTIONS).format(value)
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
  const sign = diffMs >= 0 ? 1 : -1
  if (absMs < minuteMs) {
    return translate('auto.components.automations.automationPageParts.now', 'now')
  }
  if (absMs < hourMs) {
    return formatUiNarrowRelativeTime(sign * Math.round(absMs / minuteMs), 'minute')
  }
  if (absMs < dayMs) {
    return formatUiNarrowRelativeTime(sign * Math.round(absMs / hourMs), 'hour')
  }
  return formatUiNarrowRelativeTime(sign * Math.round(absMs / dayMs), 'day')
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
      return translate('auto.components.automations.automationPageParts.runStatusPending', 'Queued')
    case 'dispatching':
      return translate(
        'auto.components.automations.automationPageParts.runStatusDispatching',
        'Starting'
      )
    case 'dispatched':
      return translate(
        'auto.components.automations.automationPageParts.runStatusDispatched',
        'Launched'
      )
    case 'completed':
      return translate('auto.components.automations.automationPageParts.runStatusCompleted', 'Done')
    case 'skipped_precheck':
      return translate(
        'auto.components.automations.automationPageParts.runStatusSkippedPrecheck',
        'Precheck skipped'
      )
    case 'skipped_missed':
      return translate(
        'auto.components.automations.automationPageParts.runStatusSkippedMissed',
        'Skipped'
      )
    case 'skipped_unavailable':
      return translate(
        'auto.components.automations.automationPageParts.runStatusSkippedUnavailable',
        'Unavailable'
      )
    case 'skipped_needs_interactive_auth':
      return translate(
        'auto.components.automations.automationPageParts.runStatusSkippedNeedsInteractiveAuth',
        'Needs credentials'
      )
    case 'dispatch_failed':
      return translate(
        'auto.components.automations.automationPageParts.runStatusDispatchFailed',
        'Failed'
      )
  }
}

export const AUTOMATION_EDITOR_SECTION_LABEL_CLASS =
  'text-[11px] font-semibold uppercase tracking-[0.05em]'

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

export function AutomationRunErrorNotice({
  label,
  error,
  className
}: {
  label: string
  error: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive',
        className
      )}
    >
      <span className="font-medium">{label}</span> {error}
    </div>
  )
}

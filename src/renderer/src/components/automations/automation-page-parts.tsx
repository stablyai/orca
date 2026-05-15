import React from 'react'
import type { Badge } from '@/components/ui/badge'
import type { AutomationRun } from '../../../../shared/automations-types'

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

export function Field({
  label,
  children
}: {
  label: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

export function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  )
}

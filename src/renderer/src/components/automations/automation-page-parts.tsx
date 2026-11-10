import React from 'react'
import type { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { PendingAutomationSetupReview } from './authoring/automation-setup-review'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'

// Reuse one formatter across run cells; per-cell construction dominates large-history rendering.
const AUTOMATION_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}

export function formatAutomationDateTime(
  value: number | null | undefined,
  t: Translate = translate,
  intlLocale?: string
): string {
  if (!value) {
    return t('auto.components.automations.automationPageParts.never', 'Never')
  }
  return uiDateTimeFormat(AUTOMATION_DATE_TIME_OPTIONS, intlLocale).format(value)
}

export function formatAutomationRelativeTime(
  value: number | null | undefined,
  now = Date.now(),
  t: Translate = translate,
  intlLocale?: string
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
    return t('auto.components.automations.automationPageParts.now', 'now')
  }
  if (absMs < hourMs) {
    return formatUiNarrowRelativeTime(sign * Math.round(absMs / minuteMs), 'minute', intlLocale)
  }
  if (absMs < dayMs) {
    return formatUiNarrowRelativeTime(sign * Math.round(absMs / hourMs), 'hour', intlLocale)
  }
  return formatUiNarrowRelativeTime(sign * Math.round(absMs / dayMs), 'day', intlLocale)
}

export function formatAutomationDateTimeWithRelative(
  value: number | null | undefined,
  now = Date.now(),
  t?: Translate,
  intlLocale?: string
): string {
  const absolute = formatAutomationDateTime(value, t, intlLocale)
  const relative = formatAutomationRelativeTime(value, now, t, intlLocale)
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

export function getAutomationRunStatusLabel(
  status: AutomationRun['status'],
  t: Translate = translate
): string {
  switch (status) {
    case 'pending':
      return t('auto.components.automations.automationPageParts.runStatusPending', 'Queued')
    case 'dispatching':
      return t('auto.components.automations.automationPageParts.runStatusDispatching', 'Starting')
    case 'dispatched':
      return t('auto.components.automations.automationPageParts.runStatusDispatched', 'Launched')
    case 'completed':
      return t('auto.components.automations.automationPageParts.runStatusCompleted', 'Done')
    case 'skipped_precheck':
      return t(
        'auto.components.automations.automationPageParts.runStatusSkippedPrecheck',
        'Precheck skipped'
      )
    case 'skipped_missed':
      return t('auto.components.automations.automationPageParts.runStatusSkippedMissed', 'Skipped')
    case 'skipped_unavailable':
      return t(
        'auto.components.automations.automationPageParts.runStatusSkippedUnavailable',
        'Unavailable'
      )
    case 'skipped_needs_interactive_auth':
      return t(
        'auto.components.automations.automationPageParts.runStatusSkippedNeedsInteractiveAuth',
        'Needs credentials'
      )
    case 'dispatch_failed':
      return t('auto.components.automations.automationPageParts.runStatusDispatchFailed', 'Failed')
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

/** The run's new workspace skipped setup because its branch's setup differs from the approved one. */
export function AutomationRunSetupSkippedNotice({
  review,
  onReview,
  className
}: {
  /** Null once the automation approved setup again. */
  review: PendingAutomationSetupReview | null
  onReview?: () => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const canReview = Boolean(review?.content && onReview)
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-sm text-status-warning-text',
        className
      )}
    >
      <span className="min-w-0 flex-1">
        {!review
          ? t(
              'automations.setupTrust.skippedSinceApproved',
              "Setup didn't run for this run because its branch's orca.yaml setup commands changed. They've since been approved, so later runs run them."
            )
          : canReview
            ? t(
                'automations.setupTrust.skippedReview',
                "Setup didn't run: this run's branch has different orca.yaml setup commands than the ones approved for this automation. Review them to run setup in later runs."
              )
            : t(
                'auto.components.automations.AutomationsPage.setupSkippedChanged',
                "Setup didn't run: this run's branch has different orca.yaml setup commands than the ones approved when the automation was saved. Save the automation again to review the current commands."
              )}
      </span>
      {canReview ? (
        <Button type="button" variant="outline" size="xs" onClick={onReview}>
          {t('automations.setupTrust.reviewAction', 'Review and approve setup')}
        </Button>
      ) : null}
    </div>
  )
}

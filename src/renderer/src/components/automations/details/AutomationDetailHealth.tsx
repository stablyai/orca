import React from 'react'
import { cn } from '@/lib/class-names'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { summarizeAutomationRunUsage } from '../../../../../shared/automations/history/automation-usage-summary'
import { formatAutomationDateTime, formatAutomationRelativeTime } from '../automation-page-parts'
import {
  getLocalAutomationLastRunSnapshot,
  type AutomationLastRunTone
} from '../listing/automation-list-last-run'
import { formatAutomationCost, formatAutomationTokens } from '../runs/automation-usage-model'
import { RUN_START_DRIFT_LABEL_MS } from '../runs/automation-run-identity-label'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

function HealthCell({
  label,
  value,
  detail,
  tone,
  title,
  onClick
}: {
  label: string
  value: string
  detail?: string | null
  tone?: AutomationLastRunTone
  title?: string
  onClick?: () => void
}): React.JSX.Element {
  const failed = tone === 'failed'
  const showDot = tone !== undefined && tone !== 'never'
  const content = (
    <>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 flex min-w-0 items-center gap-2 text-base font-semibold',
          failed && 'text-destructive'
        )}
      >
        {showDot ? (
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              failed
                ? 'bg-destructive'
                : tone === 'succeeded'
                  ? 'bg-status-success'
                  : tone === 'running'
                    ? 'animate-pulse bg-foreground motion-reduce:animate-none'
                    : 'bg-muted-foreground/70'
            )}
            aria-hidden="true"
          />
        ) : null}
        <span className="truncate tabular-nums">{value}</span>
      </div>
      {detail ? (
        <div className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums" title={detail}>
          {detail}
        </div>
      ) : null}
    </>
  )
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 bg-background px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
      title={title}
    >
      {content}
    </button>
  ) : (
    <div className="min-w-0 bg-background px-4 py-3" title={title}>
      {content}
    </div>
  )
}

/** At-a-glance run health: what happened last, what happens next, and what it has cost. */
export function AutomationDetailHealth({
  automation,
  runs,
  latestRun,
  now,
  runsUnavailable = false,
  onOpenRun
}: {
  automation: Automation
  runs: AutomationRun[]
  /** The history read failed: spend is unknown, not zero. */
  runsUnavailable?: boolean
  latestRun: AutomationRun | undefined
  now: number
  onOpenRun?: (run: AutomationRun) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()

  const lastRun = getLocalAutomationLastRunSnapshot(automation, latestRun, t)
  const lastRunRelative = formatAutomationRelativeTime(lastRun.at, now, t, intlLocale)
  const lastRunAbsolute = lastRun.at ? formatAutomationDateTime(lastRun.at, t, intlLocale) : null
  // Why: run pages and lists name a run by its scheduled slot; a late start says it started then.
  // Only a run that actually started has a start time; a skipped run's record time is not one.
  const latestStartedAt = latestRun ? (latestRun.dispatchedAt ?? latestRun.startedAt ?? null) : null
  const startedOffSchedule =
    latestRun !== undefined &&
    latestStartedAt !== null &&
    lastRun.at === latestStartedAt &&
    Math.abs(latestStartedAt - latestRun.scheduledFor) >= RUN_START_DRIFT_LABEL_MS
  const lastRunWhen =
    lastRunAbsolute && startedOffSchedule
      ? t('auto.components.automations.runIdentity.startedAt', 'Started {{time}}', {
          time: lastRunAbsolute
        })
      : lastRunAbsolute
  const lastRunValue =
    lastRun.tone === 'never'
      ? t('auto.components.automations.AutomationDetail.notRunYet', 'Not run yet')
      : lastRun.statusLabel || lastRunRelative || formatAutomationDateTime(null, t, intlLocale)
  const lastRunDetail =
    lastRun.tone === 'never'
      ? null
      : lastRun.statusLabel && lastRunRelative && lastRunWhen
        ? `${lastRunRelative} · ${lastRunWhen}`
        : lastRunWhen

  const nextRunRelative = automation.enabled
    ? formatAutomationRelativeTime(automation.nextRunAt, now, t, intlLocale)
    : null
  const nextRunValue = !automation.enabled
    ? t('auto.components.automations.AutomationsPage.paused', 'Paused')
    : (nextRunRelative ?? formatAutomationDateTime(automation.nextRunAt, t, intlLocale))
  const nextRunDetail =
    automation.enabled && nextRunRelative
      ? formatAutomationDateTime(automation.nextRunAt, t, intlLocale)
      : null

  const usage = summarizeAutomationRunUsage(runs)
  const hasUsage = usage.knownRuns > 0
  const usageValue = hasUsage
    ? formatAutomationCost(usage.estimatedCostUsd, t)
    : usage.unavailableRuns > 0 || runsUnavailable
      ? t('auto.components.automations.AutomationDetail.usageUnavailable', 'Unavailable')
      : t('auto.components.automations.AutomationDetail.noRuns', 'No runs')
  const usageDetail = hasUsage
    ? t(
        'auto.components.automations.AutomationDetail.usageDetail',
        '{{tokens}} tokens · {{known}}/{{total}} runs reported',
        {
          tokens: formatAutomationTokens(usage.totalTokens, intlLocale),
          known: usage.knownRuns,
          total: runs.length
        }
      )
    : null

  return (
    <div className="@container overflow-hidden rounded-lg border border-border/60">
      <div className="grid grid-cols-1 gap-px bg-border/60 @[30rem]:grid-cols-3">
        <HealthCell
          label={t('auto.components.automations.AutomationDetail.a7c312430d', 'Last run')}
          value={lastRunValue}
          detail={lastRunDetail}
          tone={lastRun.tone}
          onClick={latestRun && onOpenRun ? () => onOpenRun(latestRun) : undefined}
        />
        <HealthCell
          label={t('auto.components.automations.AutomationDetail.578ff46987', 'Next run')}
          value={nextRunValue}
          detail={nextRunDetail}
        />
        <HealthCell
          label={t('auto.components.automations.AutomationDetail.401f40ae79', 'Est. spend')}
          value={usageValue}
          detail={usageDetail}
        />
      </div>
    </div>
  )
}

// An automation's newest runs as a compact list, for hosts narrower than the page's runs table: the
// chat's automation card (a row opens the run) and a bot's panel (a row expands in place).
import React, { useId } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { formatAutomationDateTime, getAutomationRunStatusLabel } from '../automation-page-parts'
import { getAutomationRunContent } from './automation-run-content'
import { automationRunErrorText } from './automation-run-error-copy'

function runTone(run: AutomationRun): 'failed' | 'running' | 'done' | 'skipped' {
  if (run.status === 'dispatch_failed') {
    return 'failed'
  }
  if (run.status === 'pending' || run.status === 'dispatching' || run.status === 'dispatched') {
    return 'running'
  }
  return run.status.startsWith('skipped') ? 'skipped' : 'done'
}

const DOT_CLASS = {
  failed: 'bg-destructive',
  running: 'bg-foreground animate-pulse motion-reduce:animate-none',
  done: 'bg-foreground',
  skipped: 'bg-muted-foreground/60'
} as const

/** The run's status in a line: its status, then why it failed or was skipped. */
export function automationRunSummary(run: AutomationRun): string {
  const status = getAutomationRunStatusLabel(run.status)
  const error = run.error ? automationRunErrorText(run) : null
  return error ? `${status}: ${error}` : status
}

type RowProps = {
  run: AutomationRun
  now: number
  /** Expanded in place, with its output and `actions`. */
  expanded?: boolean
  /** A pinned run outside the newest rows says so. */
  pinnedLabel?: string
  actions?: React.ReactNode
  onPress: (run: AutomationRun) => void
}

function RunRow({
  run,
  now,
  expanded,
  pinnedLabel,
  actions,
  onPress
}: RowProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const bodyId = useId()
  const tone = runTone(run)
  const summary = automationRunSummary(run)
  const expandable = expanded !== undefined
  return (
    <li className={cn('min-w-0 rounded-md', expanded && 'bg-accent/60')}>
      <button
        type="button"
        data-automation-run-row={run.id}
        aria-expanded={expandable ? expanded : undefined}
        aria-controls={expandable && expanded ? bodyId : undefined}
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => onPress(run)}
      >
        <span
          className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', DOT_CLASS[tone])}
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          {pinnedLabel ? (
            <span className="text-2xs font-medium text-muted-foreground">{pinnedLabel}</span>
          ) : null}
          {/* Below 16rem the time drops under the title so neither truncates to nothing. */}
          <span className="flex min-w-0 items-baseline justify-between gap-2 @max-[15rem]:flex-col @max-[15rem]:gap-0">
            <span className="min-w-0 truncate text-sm text-foreground @max-[15rem]:max-w-full @max-[15rem]:whitespace-normal @max-[15rem]:[overflow-wrap:anywhere]">
              {run.title}
            </span>
            {pinnedLabel && expanded ? null : (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {pinnedLabel
                  ? formatAutomationDateTime(run.createdAt, t, intlLocale)
                  : formatUiRelativeTime(run.createdAt - now)}
              </span>
            )}
          </span>
          <span
            className={cn(
              'min-w-0 text-xs [overflow-wrap:anywhere]',
              tone === 'failed' ? 'text-destructive' : 'text-muted-foreground',
              !expanded && 'line-clamp-2'
            )}
          >
            <span className="sr-only">{getAutomationRunStatusLabel(run.status)}: </span>
            {summary}
          </span>
        </span>
        {expandable ? (
          <ChevronRight
            className={cn(
              'mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {expanded ? (
        <div id={bodyId} className="min-w-0 px-2 pb-2 pl-5.5">
          <p className="text-2xs text-muted-foreground">
            {formatAutomationDateTime(run.startedAt ?? run.createdAt, t, intlLocale)}
          </p>
          <p className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-sm border border-border/60 bg-background px-2 py-1.5 text-xs leading-relaxed [overflow-wrap:anywhere] scrollbar-sleek">
            {getAutomationRunContent(run, t)}
          </p>
          {actions ? <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">{actions}</div> : null}
        </div>
      ) : null}
    </li>
  )
}

export function AutomationRecentRunList({
  runs,
  now,
  pinned,
  expandedRunId,
  renderActions,
  onPress,
  ariaLabel
}: {
  runs: readonly AutomationRun[]
  now: number
  /** A run asked for by id that isn't among `runs`: shown first, labelled. */
  pinned?: { run: AutomationRun; label: string } | null
  /** Set (even null) to make rows expand in place; absent, a press only calls `onPress`. */
  expandedRunId?: string | null
  renderActions?: (run: AutomationRun) => React.ReactNode
  onPress: (run: AutomationRun) => void
  ariaLabel: string
}): React.JSX.Element {
  const expandable = expandedRunId !== undefined
  return (
    <ul aria-label={ariaLabel} className="flex min-w-0 flex-col gap-0.5">
      {pinned ? (
        <RunRow
          key={`pinned:${pinned.run.id}`}
          run={pinned.run}
          now={now}
          pinnedLabel={pinned.label}
          expanded={expandable ? expandedRunId === pinned.run.id : undefined}
          actions={renderActions?.(pinned.run)}
          onPress={onPress}
        />
      ) : null}
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          now={now}
          expanded={expandable ? expandedRunId === run.id : undefined}
          actions={renderActions?.(run)}
          onPress={onPress}
        />
      ))}
    </ul>
  )
}

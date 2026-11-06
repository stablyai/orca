import React, { useMemo, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { formatUiNarrowDuration, formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
import { formatCheckTimestamp } from '@/components/github/pr-check-presentation'
import type { PRCheckDetail } from '../../../../../../shared/github/check-types'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** What a row shows that only changes with its data; the age is derived from it on each clock tick. */
export type CheckRunTimeFacts = {
  /** When the check last moved: its finish, or its start while it still runs. */
  whenMs: number | null
  running: boolean
  /** The duration and earlier-commit note, joined for the row. */
  fixedText: string
  details: string[]
}

function parseTime(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function formatAge(ageMs: number): string {
  // A provider clock slightly ahead of ours must not read as a future run.
  if (ageMs < MINUTE_MS) {
    return translate('auto.components.right.sidebar.checks.panel.runTime.justNow', 'just now')
  }
  if (ageMs < HOUR_MS) {
    return formatUiNarrowRelativeTime(-Math.floor(ageMs / MINUTE_MS), 'minute')
  }
  if (ageMs < DAY_MS) {
    return formatUiNarrowRelativeTime(-Math.floor(ageMs / HOUR_MS), 'hour')
  }
  return formatUiNarrowRelativeTime(-Math.floor(ageMs / DAY_MS), 'day')
}

function formatRunDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return [
      formatUiNarrowDuration(hours, 'hour'),
      minutes ? formatUiNarrowDuration(minutes, 'minute') : ''
    ]
      .filter(Boolean)
      .join(' ')
  }
  if (minutes > 0) {
    return [
      formatUiNarrowDuration(minutes, 'minute'),
      seconds ? formatUiNarrowDuration(seconds, 'second') : ''
    ]
      .filter(Boolean)
      .join(' ')
  }
  return formatUiNarrowDuration(seconds, 'second')
}

export function getCheckRunTimeFacts(
  check: Pick<PRCheckDetail, 'status' | 'startedAt' | 'completedAt' | 'notLatestCommitSha'>
): CheckRunTimeFacts | null {
  const startedMs = parseTime(check.startedAt)
  const completedMs = parseTime(check.completedAt)
  const running = check.status !== 'completed'
  // A finished check without a finish time has no honest "when"; its start would misdate the result.
  const whenMs = running ? startedMs : completedMs
  const { notLatestCommitSha } = check
  if (whenMs === null && !notLatestCommitSha) {
    return null
  }
  const details: string[] = []
  if (whenMs !== null) {
    const started = formatCheckTimestamp(check.startedAt)
    const finished = running ? null : formatCheckTimestamp(check.completedAt)
    if (started) {
      details.push(
        translate(
          'auto.components.right.sidebar.checks.panel.runTime.started',
          'Started {{time}}',
          { time: started }
        )
      )
    }
    if (finished) {
      details.push(
        translate(
          'auto.components.right.sidebar.checks.panel.runTime.finished',
          'Finished {{time}}',
          { time: finished }
        )
      )
    }
  }
  if (notLatestCommitSha) {
    details.push(
      translate(
        'auto.components.right.sidebar.checks.panel.runTime.notLatestCommitDetail',
        'Ran on commit {{sha}}, not the latest commit',
        { sha: notLatestCommitSha.slice(0, 8) }
      )
    )
  }
  const durationMs =
    whenMs !== null && !running && startedMs !== null && completedMs !== null
      ? completedMs - startedMs
      : null
  const fixedText = [
    notLatestCommitSha
      ? translate(
          'auto.components.right.sidebar.checks.panel.runTime.notLatestCommit',
          'Earlier commit'
        )
      : null,
    // Under a second (skipped and instant runs report equal times) says nothing useful.
    durationMs !== null && durationMs >= 1000 ? formatRunDuration(durationMs) : null
  ]
    .filter(Boolean)
    .join(' · ')
  return { whenMs, running, fixedText, details }
}

export function formatCheckRunAge(facts: CheckRunTimeFacts, nowMs: number): string | null {
  if (facts.whenMs === null) {
    return null
  }
  // Beside a running icon an age would read as when it ran; show how long it has been running instead.
  return facts.running ? formatElapsed(nowMs - facts.whenMs) : formatAge(nowMs - facts.whenMs)
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < MINUTE_MS) {
    return `<${formatUiNarrowDuration(1, 'minute')}`
  }
  // Whole minutes only: the label moves on the 30 s clock, so seconds would read as stale.
  return formatRunDuration(Math.floor(elapsedMs / MINUTE_MS) * MINUTE_MS)
}

/** The check's age from the shared 30s clock the panel already ticks on, so rows add no timer. */
function useCheckRunNow(enabled: boolean): number {
  // An idle shared clock still holds its last tick until its subscription effect runs; never paint that.
  const [mountedAt] = useState(() => Date.now())
  return Math.max(useNow(30_000, enabled), mountedAt)
}

export function CheckRunTime({ check }: { check: PRCheckDetail }): React.JSX.Element | null {
  const { status, startedAt, completedAt, notLatestCommitSha } = check
  const languageRevision = useUiLanguageRevision()
  // Clock ticks change only the age, so the exact times, duration and copy are built once per data or language change.
  const facts = useMemo(
    () => getCheckRunTimeFacts({ status, startedAt, completedAt, notLatestCommitSha }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() and the date formatter read the UI language and catalogs implicitly.
    [status, startedAt, completedAt, notLatestCommitSha, languageRevision]
  )
  // Only the time a row is dated by ages; rows without it don't listen to the clock.
  const nowMs = useCheckRunNow(facts?.whenMs != null)
  if (!facts) {
    return null
  }
  const age = formatCheckRunAge(facts, nowMs)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Rows narrower than this keep only the icon, name and link; wider ones give up the duration before the age. */}
        <span className="hidden min-w-0 items-center overflow-hidden text-[11px] whitespace-nowrap text-muted-foreground tabular-nums @[19rem]:flex">
          {facts.fixedText && (
            <span className="min-w-0 truncate">
              {facts.fixedText}
              {age ? ' ·\u00a0' : null}
            </span>
          )}
          {/* The age answers "when did it run", so it never truncates; its reserved width ("10m ago", "1h 5m") keeps a growing age from re-truncating the name. */}
          {age && (
            <span
              className={cn('shrink-0 text-right', facts.running ? 'min-w-[6ch]' : 'min-w-[8ch]')}
            >
              {age}
            </span>
          )}
        </span>
      </TooltipTrigger>
      {facts.details.length > 0 && (
        <TooltipContent side="left" sideOffset={4}>
          {facts.details.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

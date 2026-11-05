import React, { useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import { formatUiNarrowDuration, formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
import { formatCheckTimestamp } from '@/components/github/pr-check-presentation'
import type { PRCheckDetail } from '../../../../../../shared/github/check-types'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export type CheckRunTimeLabel = {
  /** When the check last moved: its finish, or its start while it still runs. */
  when: string | null
  duration: string | null
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

export function getCheckRunTimeLabel(
  check: PRCheckDetail,
  nowMs: number
): CheckRunTimeLabel | null {
  const startedMs = parseTime(check.startedAt)
  const completedMs = parseTime(check.completedAt)
  const running = check.status !== 'completed'
  // A finished check without a finish time has no honest "when"; its start would misdate the result.
  const whenMs = running ? startedMs : completedMs
  if (whenMs === null) {
    return null
  }
  const durationMs =
    !running && startedMs !== null && completedMs !== null ? completedMs - startedMs : null
  const details: string[] = []
  const started = formatCheckTimestamp(check.startedAt)
  const finished = running ? null : formatCheckTimestamp(check.completedAt)
  if (started) {
    details.push(
      translate('auto.components.right.sidebar.checks.panel.runTime.started', 'Started {{time}}', {
        time: started
      })
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
  return {
    when: formatAge(nowMs - whenMs),
    // Under a second (skipped and instant runs report equal times) says nothing useful.
    duration: durationMs !== null && durationMs >= 1000 ? formatRunDuration(durationMs) : null,
    details
  }
}

/** The check's age from the shared 30s clock the panel already ticks on, so rows add no timer. */
function useCheckRunNow(enabled: boolean): number {
  // An idle shared clock still holds its last tick until its subscription effect runs; never paint that.
  const [mountedAt] = useState(() => Date.now())
  return Math.max(useNow(30_000, enabled), mountedAt)
}

export function CheckRunTime({ check }: { check: PRCheckDetail }): React.JSX.Element | null {
  // Only the time a row is dated by ages; rows without it don't listen to the clock.
  const nowMs = useCheckRunNow(
    Boolean(check.status === 'completed' ? check.completedAt : check.startedAt)
  )
  const { notLatestCommitSha } = check
  const label = getCheckRunTimeLabel(check, nowMs)
  if (!label && !notLatestCommitSha) {
    return null
  }
  const details = label?.details ?? []
  if (notLatestCommitSha) {
    details.push(
      translate(
        'auto.components.right.sidebar.checks.panel.runTime.notLatestCommitDetail',
        'Ran on commit {{sha}}, not the latest commit',
        { sha: notLatestCommitSha.slice(0, 8) }
      )
    )
  }
  const fixed = [
    notLatestCommitSha
      ? translate(
          'auto.components.right.sidebar.checks.panel.runTime.notLatestCommit',
          'Earlier commit'
        )
      : null,
    label?.duration
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
          {fixed && <span>{label?.when ? `${fixed} ·` : fixed}</span>}
          {/* The age is the only part that changes over time; its reserved width keeps "9m ago" to "10m ago" from re-truncating the name. */}
          {label?.when && <span className="min-w-[8ch] text-right">{label.when}</span>}
        </span>
      </TooltipTrigger>
      {details.length > 0 && (
        <TooltipContent side="left" sideOffset={4}>
          {details.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

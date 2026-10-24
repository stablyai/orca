import { formatUiRelativeTimeCompact } from '@/i18n/relative-time-format'
import type { SourceControlCommitTimeFormat } from '../../../../../../shared/ui-chrome-types'

// Why: the zone name disambiguates the repeated hour when clocks fall back.
const gitHistoryTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'long'
})

// Why: the year is noise in a dense column, so the list drops it until it is the only thing
// telling two rows apart — and today needs no date at all, which is where a column of times
// would otherwise crowd the subject.
const gitHistoryListTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
})
const gitHistoryListDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})
const gitHistoryListDateTimeWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

function toValidDate(timestamp: number | undefined): Date | null {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return null
  }
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatGitHistoryTimestamp(timestamp: number | undefined): string {
  const date = toValidDate(timestamp)
  return date ? gitHistoryTimestampFormatter.format(date) : ''
}

export type GitHistoryCommitTimeCell = {
  label: string
  /** A label a narrow column can hold. The row gives the width this frees back to the subject. */
  compact: boolean
}

function isSameLocalDay(candidate: Date, reference: Date): boolean {
  return (
    candidate.getFullYear() === reference.getFullYear() &&
    candidate.getMonth() === reference.getMonth() &&
    candidate.getDate() === reference.getDate()
  )
}

/**
 * The commit-time list column's cell, or `null` when the column is hidden or the timestamp is
 * unusable — so the row renders no cell rather than an empty one.
 */
export function formatGitHistoryCommitTimeColumn(
  timestamp: number | undefined,
  format: SourceControlCommitTimeFormat,
  now: number = Date.now()
): GitHistoryCommitTimeCell | null {
  if (format === 'hidden') {
    return null
  }
  const date = toValidDate(timestamp)
  if (!date) {
    return null
  }
  if (format === 'relative') {
    return { label: formatUiRelativeTimeCompact(date.getTime() - now), compact: true }
  }
  const nowDate = new Date(now)
  if (isSameLocalDay(date, nowDate)) {
    return { label: gitHistoryListTimeFormatter.format(date), compact: true }
  }
  return date.getFullYear() === nowDate.getFullYear()
    ? { label: gitHistoryListDateTimeFormatter.format(date), compact: false }
    : { label: gitHistoryListDateTimeWithYearFormatter.format(date), compact: false }
}

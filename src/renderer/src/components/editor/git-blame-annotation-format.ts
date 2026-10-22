import type { GitBlameCommit } from '../../../../shared/git-blame-types'
import { translate } from '@/i18n/i18n'
import { getUiRelativeTimeFormatter } from '@/i18n/relative-time-format'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS
const MAX_INLINE_SUMMARY_LENGTH = 80

// Why: blamed lines are often years old, so "1,200 days ago" needs month/year units.
export function formatGitBlameAge(authorTime: number, now: number): string {
  const formatter = getUiRelativeTimeFormatter()
  const diff = authorTime - now
  const abs = Math.abs(diff)
  if (abs < HOUR_MS) {
    return formatter.format(Math.round(diff / MINUTE_MS), 'minute')
  }
  if (abs < DAY_MS) {
    return formatter.format(Math.round(diff / HOUR_MS), 'hour')
  }
  if (abs < MONTH_MS) {
    return formatter.format(Math.round(diff / DAY_MS), 'day')
  }
  if (abs < YEAR_MS) {
    return formatter.format(Math.round(diff / MONTH_MS), 'month')
  }
  return formatter.format(Math.round(diff / YEAR_MS), 'year')
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

const MIN_INLINE_SUMMARY_LENGTH = 12

/** Fits the annotation into `maxLength` columns, dropping the summary first; null when nothing fits. */
export function formatGitBlameInlineText(
  commit: GitBlameCommit,
  now: number,
  maxLength = Number.POSITIVE_INFINITY
): string | null {
  if (commit.uncommitted) {
    const text = translate(
      'auto.components.editor.git.blame.annotation.format.6e419cb250',
      'You • Uncommitted changes'
    )
    return text.length <= maxLength ? text : null
  }
  const attribution = `${commit.author}, ${formatGitBlameAge(commit.authorTime, now)}`
  const summaryRoom = Math.min(maxLength - attribution.length - 3, MAX_INLINE_SUMMARY_LENGTH)
  if (commit.summary && summaryRoom >= MIN_INLINE_SUMMARY_LENGTH) {
    return `${attribution} • ${truncate(commit.summary, summaryRoom)}`
  }
  return attribution.length <= maxLength ? attribution : null
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&')
}

export function formatGitBlameHoverMarkdown(commit: GitBlameCommit, now: number): string {
  if (commit.uncommitted) {
    return translate(
      'auto.components.editor.git.blame.annotation.format.8a0cf790c5',
      'Uncommitted changes'
    )
  }
  const date = new Date(commit.authorTime).toLocaleString()
  const email = commit.authorEmail ? ` <${commit.authorEmail}>` : ''
  const age = formatGitBlameAge(commit.authorTime, now)
  // Why separate paragraphs: the hover is anchored at line end, so one long row runs past the pane.
  return [
    `**${escapeMarkdown(commit.author)}**${escapeMarkdown(email)}`,
    '',
    `${escapeMarkdown(age)} · ${escapeMarkdown(date)}`,
    '',
    escapeMarkdown(commit.summary),
    '',
    `\`${commit.sha.slice(0, 8)}\``
  ].join('\n')
}

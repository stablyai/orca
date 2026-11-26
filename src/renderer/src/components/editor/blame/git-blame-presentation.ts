import { formatUiCoarseRelativeTime } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { IMarkdownString } from 'monaco-editor'
import type { GitBlameCommit } from '../../../../../shared/git/blame/git-blame-types'
import type { LineBlame } from './git-blame-line-store'

const DATE_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }

/** `Ada Lovelace, 3 months ago`, shared by the inline annotation and the status bar. */
export function formatLineBlameSummary(line: LineBlame, now = Date.now()): string {
  if (line.kind === 'uncommitted') {
    return translate('editor.gitBlame.uncommitted', 'Uncommitted changes')
  }
  const { author, authorTime } = line.commit
  return `${author}, ${formatUiCoarseRelativeTime(authorTime - now)}`
}

export function formatBlameCommitDetails(commit: GitBlameCommit): {
  heading: string
  date: string
  shortOid: string
  summary: string
} {
  return {
    heading: commit.authorEmail ? `${commit.author} <${commit.authorEmail}>` : commit.author,
    date: uiDateTimeFormat(DATE_FORMAT).format(commit.authorTime),
    shortOid: commit.oid.slice(0, 8),
    summary: commit.summary
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, '\\$&')
}

export function blameHoverMarkdown(commit: GitBlameCommit): IMarkdownString {
  const details = formatBlameCommitDetails(commit)
  return {
    value: [
      `**${escapeMarkdown(details.heading)}**`,
      `${escapeMarkdown(details.date)} · \`${details.shortOid}\``,
      escapeMarkdown(details.summary)
    ].join('\n\n')
  }
}

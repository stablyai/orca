import type { GitBlameRange } from '../../../../shared/git-blame'
import { translate } from '../../i18n/i18n'

export function findGitBlameRangeForLine(
  ranges: GitBlameRange[],
  lineNumber: number
): GitBlameRange | null {
  return (
    ranges.find((range) => range.startLine <= lineNumber && range.endLine >= lineNumber) ?? null
  )
}

export function formatGitBlameInlineLabel(range: GitBlameRange): string {
  if (!range.commitId) {
    return translate('editor.gitBlame.uncommitted', 'Uncommitted')
  }
  const date = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(range.authoredAt * 1000))
  return `${range.author}, ${date} · ${range.summary}`
}

import { translate } from '../../i18n/i18n'
import type { GitBlameRange } from '../../../../shared/git-blame'

export function buildGitBlameHoverMarkdown(range: GitBlameRange): { value: string } {
  if (!range.commitId) {
    return { value: translate('editor.gitBlame.uncommittedLine', 'Uncommitted line') }
  }
  const author = escapeMonacoMarkdownText(range.author)
  const email = escapeMonacoMarkdownText(range.authorEmail)
  const summary = escapeMonacoMarkdownText(range.summary)
  const actionHint = translate(
    'editor.gitBlame.clickForCommitActions',
    'Click for commit actions.'
  )
  return {
    value: `**${author}** &lt;${email}&gt;  \n${new Date(range.authoredAt * 1000).toLocaleString()}  \n\`${range.commitId}\`  \n${summary}  \n\n${actionHint}`
  }
}

export function escapeMonacoMarkdownText(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_[\]{}()#+\-.!|]/g, '\\$&')
}

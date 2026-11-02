import type { DiffComment } from '../../../../shared/diff-comment-types'
import { translate } from '@/i18n/i18n'

// Card meta text, e.g. "Note line 4 sent"; agent prompts keep the English getDiffCommentLineLabel.
export function getDiffCommentLineMetaLabel(
  comment: Pick<DiffComment, 'lineNumber' | 'startLine'>
): string {
  if (comment.startLine !== undefined && comment.startLine !== comment.lineNumber) {
    return translate('diffComments.lineRangeMeta', 'lines {{start}}-{{end}}', {
      start: comment.startLine,
      end: comment.lineNumber
    })
  }
  return translate('diffComments.lineMeta', 'line {{line}}', { line: comment.lineNumber })
}

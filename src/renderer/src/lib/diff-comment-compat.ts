import type { DiffComment, DiffCommentSource } from '../../../shared/types'

export function getDiffCommentSource(comment: Pick<DiffComment, 'source'>): DiffCommentSource {
  return comment.source === 'markdown' ? 'markdown' : 'diff'
}

export function isDiffComment(comment: Pick<DiffComment, 'source'>): boolean {
  return getDiffCommentSource(comment) === 'diff'
}

export function isMarkdownComment(comment: Pick<DiffComment, 'source'>): boolean {
  return getDiffCommentSource(comment) === 'markdown'
}

export function getDiffCommentLineLabel(
  comment: Pick<DiffComment, 'lineNumber' | 'startLine'>,
  compact = false
): string {
  if (comment.startLine !== undefined && comment.startLine !== comment.lineNumber) {
    return compact
      ? `L${comment.startLine}-L${comment.lineNumber}`
      : `Lines ${comment.startLine}-${comment.lineNumber}`
  }
  return compact ? `L${comment.lineNumber}` : `Line ${comment.lineNumber}`
}

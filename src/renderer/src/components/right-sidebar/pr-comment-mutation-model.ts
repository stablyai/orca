import type { PRComment } from '../../../../shared/types'

/** Format a line range string like "L12" or "L5-L12". */
export function formatLineRange(comment: PRComment): string | null {
  if (!comment.line) {
    return null
  }
  if (comment.startLine && comment.startLine !== comment.line) {
    return `L${comment.startLine}-L${comment.line}`
  }
  return `L${comment.line}`
}

/** True for top-level PR conversation comments the viewer can edit or delete. */
export function isMutablePRConversationComment(comment: PRComment): boolean {
  if (comment.threadId || comment.path) {
    return false
  }
  if (comment.url && comment.url.includes('pullrequestreview')) {
    return false
  }
  return Number.isSafeInteger(comment.id) && comment.id > 0
}

/** Build copy text that includes file location context for review comments. */
export function buildPRCommentCopyText(comment: PRComment): string {
  if (!comment.path) {
    return comment.body
  }
  const lineRange = formatLineRange(comment)
  const location = lineRange ? `${comment.path}:${lineRange}` : comment.path
  return `File: ${location}\n\n${comment.body}`
}

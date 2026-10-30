import type { PRComment } from './comment-types'

export type PRCommentInlineAnchor = {
  path: string
  line: number
  startLine?: number
}

/** Where a review comment sits in the current diff, or null when it has no line there. */
export function getPRCommentInlineAnchor(comment: PRComment): PRCommentInlineAnchor | null {
  // Why: outdated threads keep originalLine for the sidebar, but rendering it inline can attach the comment to unrelated current code.
  if (comment.isOutdated || !comment.path || typeof comment.line !== 'number') {
    return null
  }
  return {
    path: comment.path,
    line: comment.line,
    ...(comment.startLine === undefined ? {} : { startLine: comment.startLine })
  }
}

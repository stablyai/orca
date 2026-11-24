import type { PRComment } from './comment-types'

export type PRInlineCommentPlacement = {
  path: string
  line: number
  startLine: number | undefined
}

/** Where a PR review comment sits in the current diff, or null when it should not render inline. */
export function getPRInlineCommentPlacement(comment: PRComment): PRInlineCommentPlacement | null {
  // Why: outdated threads keep originalLine for the sidebar, but rendering it inline can attach the comment to unrelated current code.
  if (comment.isOutdated || !comment.path || typeof comment.line !== 'number') {
    return null
  }
  return { path: comment.path, line: comment.line, startLine: comment.startLine }
}

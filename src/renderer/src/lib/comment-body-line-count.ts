export const COMMENT_BODY_LAYOUT_MAX_LINES = 80
export const COMMENT_BODY_LINE_COUNT_SCAN_CODE_UNITS = 64 * 1024

export function getCommentBodyLayoutLineCount(body: string): number {
  if (body.length === 0) {
    return 1
  }

  let lineCount = 1
  const scanLength = Math.min(body.length, COMMENT_BODY_LINE_COUNT_SCAN_CODE_UNITS)
  for (let index = 0; index < scanLength; index += 1) {
    if (body.charCodeAt(index) !== 10) {
      continue
    }
    lineCount += 1
    if (lineCount >= COMMENT_BODY_LAYOUT_MAX_LINES) {
      return COMMENT_BODY_LAYOUT_MAX_LINES
    }
  }
  return lineCount
}

// Why: each reply adds its own meta row and spacing on top of its body lines.
const REVIEW_THREAD_REPLY_CHROME_LINES = 2

export function getReviewThreadLayoutLineCount(comment: {
  body: string
  reviewThread?: { isResolved: boolean; replies: readonly { body: string }[] }
}): number {
  const thread = comment.reviewThread
  if (!thread) {
    return getCommentBodyLayoutLineCount(comment.body)
  }
  // Resolved threads mount collapsed to a single summary row.
  if (thread.isResolved) {
    return 1
  }
  let lineCount = getCommentBodyLayoutLineCount(comment.body)
  for (const reply of thread.replies) {
    lineCount += getCommentBodyLayoutLineCount(reply.body) + REVIEW_THREAD_REPLY_CHROME_LINES
  }
  return lineCount
}

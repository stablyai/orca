import type { PRComment } from './comment-types'

// Conversation comments only: review threads and review summaries edit through other APIs.
export function isMutablePRConversationComment(
  comment: Pick<PRComment, 'id' | 'threadId' | 'path' | 'url'>
): boolean {
  if (comment.threadId || comment.path) {
    return false
  }
  if (comment.url && comment.url.includes('pullrequestreview')) {
    return false
  }
  return Number.isSafeInteger(comment.id) && comment.id > 0
}

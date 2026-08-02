import type { PRComment } from '../../../../shared/types'

export function markPRCommentThreadResolved(
  comments: PRComment[],
  threadId: string,
  isResolved: boolean
): PRComment[] {
  return comments.map((comment) =>
    comment.threadId === threadId ? { ...comment, isResolved } : comment
  )
}

export function restorePRCommentThreadSnapshot(
  comments: PRComment[],
  previousThreadComments: PRComment[]
): PRComment[] {
  const previousById = new Map(previousThreadComments.map((comment) => [comment.id, comment]))
  return comments.map((comment) =>
    previousById.has(comment.id) ? (previousById.get(comment.id) ?? comment) : comment
  )
}

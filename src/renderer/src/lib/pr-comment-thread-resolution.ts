import type { PRComment } from '../../../shared/github/comment-types'

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
  const previousResolutionByThread = new Map<string, boolean>()
  for (const previous of previousThreadComments) {
    if (
      previous.threadId !== undefined &&
      previous.isResolved !== undefined &&
      !previousResolutionByThread.has(previous.threadId)
    ) {
      previousResolutionByThread.set(previous.threadId, previous.isResolved)
    }
  }
  return comments.map((comment) => {
    const previous = previousById.get(comment.id)
    if (previous) {
      return { ...comment, isResolved: previous.isResolved }
    }
    const isResolved =
      comment.threadId === undefined ? undefined : previousResolutionByThread.get(comment.threadId)
    return isResolved === undefined ? comment : { ...comment, isResolved }
  })
}

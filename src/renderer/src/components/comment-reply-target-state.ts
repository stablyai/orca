export type CommentReplyTargetComment = {
  id: number
}

export function resolveCommentReplyTarget(
  replyingTo: number | null,
  visibleComments: readonly CommentReplyTargetComment[]
): number | null {
  if (replyingTo === null) {
    return null
  }
  return visibleComments.some((comment) => comment.id === replyingTo) ? replyingTo : null
}

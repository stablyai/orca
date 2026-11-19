export type CommentReplyTargetComment = {
  id: number
}

export function getCommentReplyTargetCandidates(
  itemType: 'issue' | 'pr',
  comments: readonly CommentReplyTargetComment[],
  visibleComments: readonly CommentReplyTargetComment[]
): readonly CommentReplyTargetComment[] {
  // Issue views hide PR audience filters; ignore stale PR filter state when choosing issue reply targets.
  return itemType === 'issue' ? comments : visibleComments
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

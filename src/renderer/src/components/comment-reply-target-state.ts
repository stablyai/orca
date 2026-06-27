export type CommentReplyTargetComment = {
  id: number
}

export function getCommentReplyTargetCandidates(
  itemType: 'issue' | 'pr',
  comments: readonly CommentReplyTargetComment[],
  visibleComments: readonly CommentReplyTargetComment[]
): readonly CommentReplyTargetComment[] {
  // Why: the PR audience filter is hidden on issues, so stale PR filter state
  // should not constrain issue reply targets after switching items.
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

import type {
  GitHubReaction,
  GitHubReactionContent,
  PRComment
} from '../../../shared/github/comment-types'

export const GITHUB_REACTION_ORDER: readonly GitHubReactionContent[] = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
]

function sortReactions(reactions: GitHubReaction[]): GitHubReaction[] {
  return reactions.sort(
    (left, right) =>
      GITHUB_REACTION_ORDER.indexOf(left.content) - GITHUB_REACTION_ORDER.indexOf(right.content)
  )
}

export function setCommentReaction(
  comment: PRComment,
  content: GitHubReactionContent,
  reacted: boolean
): PRComment {
  const reactions = comment.reactions ?? []
  const current = reactions.find((reaction) => reaction.content === content)
  if (Boolean(current?.viewerHasReacted) === reacted) {
    return comment
  }

  const nextCount = Math.max(0, (current?.count ?? 0) + (reacted ? 1 : -1))
  const nextReaction: GitHubReaction = {
    content,
    count: nextCount,
    viewerHasReacted: reacted
  }
  const nextReactions = sortReactions(
    reactions
      .filter((reaction) => reaction.content !== content)
      .concat(nextCount > 0 ? nextReaction : [])
  )

  return { ...comment, reactions: nextReactions.length > 0 ? nextReactions : undefined }
}

export function restoreCommentReaction(
  comment: PRComment,
  content: GitHubReactionContent,
  previousReaction?: GitHubReaction
): PRComment {
  const reactions = sortReactions([
    ...(comment.reactions ?? []).filter((reaction) => reaction.content !== content),
    ...(previousReaction ? [previousReaction] : [])
  ])
  return { ...comment, reactions: reactions.length > 0 ? reactions : undefined }
}

export function setReactionOnSubject(
  comments: readonly PRComment[],
  reactionSubjectId: string,
  content: GitHubReactionContent,
  reacted: boolean
): PRComment[] {
  return comments.map((comment) =>
    comment.reactionSubjectId === reactionSubjectId
      ? setCommentReaction(comment, content, reacted)
      : comment
  )
}

export function restoreReactionOnSubject(
  comments: readonly PRComment[],
  reactionSubjectId: string,
  content: GitHubReactionContent,
  previousReaction?: GitHubReaction
): PRComment[] {
  return comments.map((comment) =>
    comment.reactionSubjectId === reactionSubjectId
      ? restoreCommentReaction(comment, content, previousReaction)
      : comment
  )
}

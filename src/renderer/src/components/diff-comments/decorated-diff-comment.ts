import type { GitHubReaction } from '../../../../shared/github/comment-types'
import type { DiffComment } from '../../../../shared/diff-comment-types'

export type DiffCommentReviewThreadReply = {
  id: string
  body: string
  author?: string
  createdAtLabel?: string
  url?: string
  reactions?: GitHubReaction[]
  /** Unsubmitted draft belonging to the viewer's pending review. */
  isPending?: boolean
}

export type DiffCommentReviewThread = {
  isResolved: boolean
  isOutdated?: boolean
  /** Diff side the thread anchors to; LEFT threads target the base file. */
  diffSide?: 'LEFT' | 'RIGHT'
  replies: DiffCommentReviewThreadReply[]
}

export type DecoratedDiffComment = DiffComment & {
  author?: string
  authorAvatarUrl?: string
  createdAtLabel?: string
  url?: string
  canDelete?: boolean
  canEdit?: boolean
  reactions?: GitHubReaction[]
  /** Root comment is an unsubmitted draft of the viewer's pending review. */
  isPendingReview?: boolean
  /** Current text of the commented range at the PR head; feeds ```suggestion previews. */
  suggestionTargetLines?: string[]
  reviewThread?: DiffCommentReviewThread
}

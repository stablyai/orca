import type { DecoratedDiffComment } from '@/components/diff-comments/decorated-diff-comment'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { getPRInlineCommentPlacement } from '../../../../../shared/github/pr-inline-comment-placement'

export function buildInlineReviewComments(
  comments: PRComment[],
  repoId: string,
  prNumber: number
): DecoratedDiffComment[] {
  return comments.flatMap((comment): DecoratedDiffComment[] => {
    const placement = getPRInlineCommentPlacement(comment)
    if (!placement) {
      return []
    }
    const createdAtMs = new Date(comment.createdAt).getTime()
    return [
      {
        id: `github-pr-comment:${comment.id}`,
        worktreeId: `github-pr:${repoId}:${prNumber}`,
        filePath: placement.path,
        source: 'diff',
        startLine: placement.startLine,
        lineNumber: placement.line,
        body: comment.body,
        createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
        side: 'modified',
        author: comment.author,
        authorAvatarUrl: comment.authorAvatarUrl,
        createdAtLabel: formatRelativeTime(comment.createdAt),
        url: comment.url,
        canDelete: false,
        canEdit: false
      }
    ]
  })
}

import type { DecoratedDiffComment } from '@/components/diff-comments/decorated-diff-comment'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { getPRCommentInlineAnchor } from '../../../../../shared/github/pr-comment-inline-anchor'

export function buildInlineReviewComments(
  comments: PRComment[],
  repoId: string,
  prNumber: number
): DecoratedDiffComment[] {
  return comments.flatMap((comment): DecoratedDiffComment[] => {
    const anchor = getPRCommentInlineAnchor(comment)
    if (!anchor) {
      return []
    }
    const createdAtMs = new Date(comment.createdAt).getTime()
    return [
      {
        id: `github-pr-comment:${comment.id}`,
        worktreeId: `github-pr:${repoId}:${prNumber}`,
        filePath: anchor.path,
        source: 'diff',
        startLine: anchor.startLine,
        lineNumber: anchor.line,
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

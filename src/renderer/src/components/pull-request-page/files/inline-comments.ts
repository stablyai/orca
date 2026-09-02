import type { DecoratedDiffComment } from '@/components/diff-comments/decorated-diff-comment'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import type { PRComment } from '../../../../../shared/github/comment-types'

export function buildInlineReviewComments(
  comments: PRComment[],
  repoId: string,
  prNumber: number
): DecoratedDiffComment[] {
  return comments.flatMap((comment): DecoratedDiffComment[] => {
    // Why: outdated threads keep originalLine for the sidebar, but rendering it inline can attach the comment to unrelated current code.
    if (comment.isOutdated || !comment.path || typeof comment.line !== 'number') {
      return []
    }
    const createdAtMs = new Date(comment.createdAt).getTime()
    return [
      {
        id: `github-pr-comment:${comment.id}`,
        worktreeId: `github-pr:${repoId}:${prNumber}`,
        filePath: comment.path,
        source: 'diff',
        startLine: comment.startLine,
        lineNumber: comment.line,
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

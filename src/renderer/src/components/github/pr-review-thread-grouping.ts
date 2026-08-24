import type {
  DecoratedDiffComment,
  DiffCommentReviewThreadReply
} from '@/components/diff-comments/decorated-diff-comment'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import type { PRComment } from '../../../../shared/github/comment-types'

// Groups a PR's flat review comments into per-thread items (root + ordered
// replies) shaped for the diff comment decorator's ReviewThreadCard rendering.

/** Stable grouping key: thread node id, or a per-comment key for ungrouped comments. */
export function reviewThreadKey(comment: Pick<PRComment, 'threadId' | 'id'>): string {
  return comment.threadId ?? `comment:${String(comment.id)}`
}

function mapReply(reply: PRComment): DiffCommentReviewThreadReply {
  return {
    id: String(reply.id),
    body: reply.body,
    author: reply.author,
    createdAtLabel: formatRelativeTime(reply.createdAt),
    url: reply.url,
    reactions: reply.reactions,
    isPending: reply.isPending
  }
}

function groupThreads(comments: readonly PRComment[]): PRComment[][] {
  const threads = new Map<string, PRComment[]>()
  for (const comment of comments) {
    const key = reviewThreadKey(comment)
    const members = threads.get(key)
    if (members) {
      members.push(comment)
    } else {
      threads.set(key, [comment])
    }
  }
  return Array.from(threads.values(), (members) =>
    members
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  )
}

function mapThread(ordered: PRComment[], repoId: string, prNumber: number): DecoratedDiffComment {
  const root = ordered[0] as PRComment
  const createdAtMs = new Date(root.createdAt).getTime()
  return {
    id: `github-pr-thread:${root.threadId ?? String(root.id)}`,
    worktreeId: `github-pr:${repoId}:${prNumber}`,
    filePath: root.path as string,
    source: 'diff' as const,
    startLine: root.startLine,
    // Why: 0 marks file-level threads (no line anywhere); the card hides the line label for them.
    lineNumber: root.line ?? 0,
    body: root.body,
    createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
    side: 'modified' as const,
    author: root.author,
    authorAvatarUrl: root.authorAvatarUrl,
    createdAtLabel: formatRelativeTime(root.createdAt),
    url: root.url,
    reactions: root.reactions,
    isPendingReview: root.isPending,
    reviewThread: {
      isResolved: root.isResolved === true,
      isOutdated: root.isOutdated === true,
      diffSide: root.diffSide,
      replies: ordered.slice(1).map(mapReply)
    }
  }
}

export function buildReviewThreadItems(
  comments: readonly PRComment[],
  repoId: string,
  prNumber: number
): DecoratedDiffComment[] {
  const inline = comments.filter(
    // Why: outdated threads keep originalLine for the sidebar, but rendering it inline can attach the comment to unrelated current code.
    (comment) => !comment.isOutdated && !!comment.path && typeof comment.line === 'number'
  )
  return groupThreads(inline).map((ordered) => mapThread(ordered, repoId, prNumber))
}

/** Threads with no current diff line — outdated ones and file-level comments; rendered in a per-file group, never inline. */
export function buildOutdatedReviewThreadItems(
  comments: readonly PRComment[],
  repoId: string,
  prNumber: number
): DecoratedDiffComment[] {
  const outdated = comments.filter(
    (comment) => !!comment.path && (comment.isOutdated || typeof comment.line !== 'number')
  )
  return groupThreads(outdated).map((ordered) => mapThread(ordered, repoId, prNumber))
}

/** Thread counts per file path, matching exactly what the two builders will render. */
export function countReviewThreadsByPath(comments: readonly PRComment[]): Map<string, number> {
  const threadsByPath = new Map<string, Set<string>>()
  for (const comment of comments) {
    if (!comment.path) {
      continue
    }
    const threads = threadsByPath.get(comment.path) ?? new Set<string>()
    threads.add(reviewThreadKey(comment))
    threadsByPath.set(comment.path, threads)
  }
  return new Map(Array.from(threadsByPath, ([path, threads]) => [path, threads.size]))
}

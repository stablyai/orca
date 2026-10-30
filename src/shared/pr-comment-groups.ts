import type { PRComment } from './github/comment-types'

export type PRCommentGroup =
  | { kind: 'standalone'; comment: PRComment }
  | { kind: 'thread'; threadId: string; root: PRComment; replies: PRComment[] }

export function groupPRComments(comments: readonly PRComment[]): PRCommentGroup[] {
  const groups: PRCommentGroup[] = []
  const threads = new Map<string, Extract<PRCommentGroup, { kind: 'thread' }>>()

  for (const comment of comments) {
    if (!comment.threadId) {
      groups.push({ kind: 'standalone', comment })
      continue
    }
    const existing = threads.get(comment.threadId)
    if (existing) {
      existing.replies.push(comment)
      continue
    }
    const group: Extract<PRCommentGroup, { kind: 'thread' }> = {
      kind: 'thread',
      threadId: comment.threadId,
      root: comment,
      replies: []
    }
    threads.set(comment.threadId, group)
    groups.push(group)
  }
  return groups
}

export function getPRCommentGroupRoot(group: PRCommentGroup): PRComment {
  return group.kind === 'thread' ? group.root : group.comment
}

export function getPRCommentGroupCount(group: PRCommentGroup): number {
  return group.kind === 'thread' ? group.replies.length + 1 : 1
}

export function isResolvedPRCommentGroup(group: PRCommentGroup): boolean {
  return getPRCommentGroupRoot(group).isResolved === true
}

/** Drops every comment in a resolved review thread; standalone comments are never resolvable. */
export function excludeResolvedPRCommentThreads(comments: readonly PRComment[]): PRComment[] {
  const resolvedThreadIds = new Set<string>()
  for (const group of groupPRComments(comments)) {
    if (group.kind === 'thread' && isResolvedPRCommentGroup(group)) {
      resolvedThreadIds.add(group.threadId)
    }
  }
  return comments.filter((comment) => !comment.threadId || !resolvedThreadIds.has(comment.threadId))
}

export function getPRCommentGroupId(group: PRCommentGroup): string {
  return group.kind === 'thread' ? `thread:${group.threadId}` : `comment:${group.comment.id}`
}

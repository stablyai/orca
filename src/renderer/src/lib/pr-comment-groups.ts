import type { PRComment } from '../../../shared/types'

export const PR_COMMENT_RESOLVED_CONTAINER_CLASS = 'opacity-50'
export const PR_COMMENT_RESOLVED_AUTHOR_CLASS = 'text-muted-foreground'
export const PR_COMMENT_OPEN_AUTHOR_CLASS = 'text-foreground'

export type PRCommentGroup =
  | { kind: 'standalone'; comment: PRComment }
  | { kind: 'thread'; threadId: string; root: PRComment; replies: PRComment[] }

export function groupPRComments(comments: PRComment[]): PRCommentGroup[] {
  const threadMap = new Map<string, { root: PRComment; replies: PRComment[] }>()
  const groupsByFirstComment = new Map<PRComment, PRCommentGroup>()

  for (const comment of comments) {
    if (!comment.threadId) {
      groupsByFirstComment.set(comment, { kind: 'standalone', comment })
      continue
    }
    const existing = threadMap.get(comment.threadId)
    if (existing) {
      existing.replies.push(comment)
      continue
    }
    threadMap.set(comment.threadId, { root: comment, replies: [] })
  }

  const emitted = new Set<string>()
  const groups: PRCommentGroup[] = []
  for (const comment of comments) {
    if (!comment.threadId) {
      const group = groupsByFirstComment.get(comment)
      if (group) {
        groups.push(group)
      }
      continue
    }
    if (emitted.has(comment.threadId)) {
      continue
    }
    emitted.add(comment.threadId)
    const thread = threadMap.get(comment.threadId)
    if (thread) {
      groups.push({ kind: 'thread', threadId: comment.threadId, ...thread })
    }
  }
  return groups
}

export function getPRCommentGroupComments(group: PRCommentGroup): PRComment[] {
  return group.kind === 'thread' ? [group.root, ...group.replies] : [group.comment]
}

export function getPRCommentGroupRoot(group: PRCommentGroup): PRComment {
  return group.kind === 'thread' ? group.root : group.comment
}

export function getPRCommentGroupCount(group: PRCommentGroup): number {
  return getPRCommentGroupComments(group).length
}

export function isResolvedPRCommentGroup(group: PRCommentGroup): boolean {
  return getPRCommentGroupRoot(group).isResolved === true
}

export function getPRCommentGroupId(group: PRCommentGroup): string {
  return group.kind === 'thread' ? `thread:${group.threadId}` : `comment:${group.comment.id}`
}

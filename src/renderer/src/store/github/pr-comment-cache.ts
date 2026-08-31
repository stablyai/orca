import type { GitHubCommentResult, PRComment } from '../../../../shared/github/comment-types'

function commentTimestamp(comment: PRComment): number {
  const timestamp = new Date(comment.createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function mergePRCommentIntoList(
  comments: readonly PRComment[] | null | undefined,
  incoming: PRComment
): PRComment[] {
  const byId = new Map<number, PRComment>()
  for (const comment of comments ?? []) {
    byId.set(comment.id, comment)
  }
  const previous = byId.get(incoming.id)
  byId.set(incoming.id, {
    ...previous,
    ...incoming,
    threadId: incoming.threadId ?? previous?.threadId,
    path: incoming.path ?? previous?.path,
    line: incoming.line ?? previous?.line,
    startLine: incoming.startLine ?? previous?.startLine,
    isResolved: incoming.isResolved ?? previous?.isResolved,
    isOutdated: incoming.isOutdated ?? previous?.isOutdated
  })
  return Array.from(byId.values()).sort((a, b) => commentTimestamp(a) - commentTimestamp(b))
}

export function hasUsableCommentPayload(result: GitHubCommentResult): result is {
  ok: true
  comment: PRComment
} {
  return (
    result.ok &&
    typeof result.comment?.id === 'number' &&
    Number.isSafeInteger(result.comment.id) &&
    result.comment.id > 0 &&
    typeof result.comment.body === 'string' &&
    typeof result.comment.createdAt === 'string'
  )
}

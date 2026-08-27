import type { PRComment } from '../../../../shared/github/comment-types'

/** Posted when a selected review comment is sent to AI. */
export const PR_COMMENT_AI_FIXING_REPLY = 'Fixing. Will be in the next commit'

/**
 * GitHub App logins carry a `[bot]` suffix that does not resolve as an @-mention
 * (`@coderabbitai[bot]` renders literally; `@coderabbitai` reaches the bot).
 */
export function formatPRCommentMentionHandle(author: string | undefined): string {
  return (author ?? '').replace(/\[bot\]$/i, '').trim()
}

/** Top-level conversation reply body, addressed to the comment author. */
export function buildPRCommentConversationReplyBody(
  author: string | undefined,
  body: string
): string {
  const handle = formatPRCommentMentionHandle(author)
  return handle ? `@${handle} ${body}` : body
}

const ACK_SNIPPET_MAX_LENGTH = 72

/** First readable line of a comment body, minus HTML comments and markdown markers. */
function summarizePRCommentBody(body: string): string {
  const line = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .map((candidate) =>
      candidate
        .replace(/^[\s>#*\-_`]+/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .find((candidate) => candidate.length > 0)
  if (!line) {
    return ''
  }
  return line.length > ACK_SNIPPET_MAX_LENGTH
    ? `${line.slice(0, ACK_SNIPPET_MAX_LENGTH - 1).trimEnd()}…`
    : line
}

/** Short "what this was" label so the batched reply names each item without quoting it whole. */
export function describePRCommentAckTarget(comment: PRComment): string {
  const kind =
    typeof comment.url === 'string' && comment.url.includes('pullrequestreview')
      ? 'review summary'
      : comment.path
        ? `comment on ${comment.path}${comment.line == null ? '' : `:${comment.line}`}`
        : 'comment'
  const snippet = summarizePRCommentBody(comment.body)
  return snippet ? `${kind} — ${snippet}` : kind
}

/**
 * One conversation comment covering every selected comment that has no nested-reply
 * endpoint, so a bulk send leaves a single readable ack instead of N "Fixing." posts.
 */
export function buildPRCommentBatchConversationReplyBody(comments: readonly PRComment[]): string {
  if (comments.length === 0) {
    return ''
  }
  const first = comments[0]!
  if (comments.length === 1) {
    return buildPRCommentConversationReplyBody(first.author, PR_COMMENT_AI_FIXING_REPLY)
  }
  const items = comments.map((comment) => {
    const handle = formatPRCommentMentionHandle(comment.author)
    const label = describePRCommentAckTarget(comment)
    return handle ? `- @${handle}: ${label}` : `- ${label}`
  })
  return `Fixing:\n${items.join('\n')}\n\nWill be in the next commit.`
}

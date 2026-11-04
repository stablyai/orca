import type { PRComment } from '../../../../shared/github/comment-types'

/** Posted when a selected review comment is sent to AI. */
export const PR_COMMENT_AI_FIXING_REPLY = 'Fixing. Will be in the next commit'

/** Strip GitHub App [bot] suffixes because @coderabbitai[bot] is literal while @coderabbitai mentions the bot. */
export function formatPRCommentMentionHandle(author: string | undefined): string {
  return (author ?? '').replace(/\[bot\]$/i, '').trim()
}

export function buildPRCommentConversationReplyBody(
  author: string | undefined,
  body: string
): string {
  const handle = formatPRCommentMentionHandle(author)
  return handle ? `@${handle} ${body}` : body
}

const ACK_SNIPPET_MAX_LENGTH = 72

function summarizePRCommentBody(body: string): string {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, ' ')
  let start = 0
  while (start <= cleaned.length) {
    const newline = cleaned.indexOf('\n', start)
    const line = cleaned
      .slice(start, newline === -1 ? cleaned.length : newline)
      .replace(/^[\s>#*\-_`]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) {
      return line.length > ACK_SNIPPET_MAX_LENGTH
        ? `${line.slice(0, ACK_SNIPPET_MAX_LENGTH - 1).trimEnd()}…`
        : line
    }
    if (newline === -1) {
      break
    }
    start = newline + 1
  }
  return ''
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

/** Batch selections without nested-reply endpoints into one acknowledgement rather than repeated Fixing posts. */
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

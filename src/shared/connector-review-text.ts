import type { ConnectorReview } from './connector-review-contract'

/** Where no review can carry them, a review's notes follow the text as `path:line` lines. */
export function connectorReviewText(text: string, review: ConnectorReview): string {
  const notes = review.comments.map(
    (note) => `${note.path}:${note.line}${note.side === 'LEFT' ? ' (old)' : ''}: ${note.body}`
  )
  return [text, '', ...notes].join('\n')
}

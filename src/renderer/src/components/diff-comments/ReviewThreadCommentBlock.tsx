import type { ReactNode } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { CommentSuggestionOptions } from '@/components/sidebar/comment-suggestion-fence'
import { CommentReactions } from '@/components/github/CommentReactions'
import { translate } from '@/i18n/i18n'
import type { GitHubReaction } from '../../../../shared/github/comment-types'

// Why: one comment row inside a hosted-review thread card (root or reply).

export type ReviewThreadCommentBlockProps = {
  body: string
  author?: string
  createdAtLabel?: string
  url?: string
  isPending?: boolean
  reactions?: GitHubReaction[]
  metaPrefix?: ReactNode
  metaActions?: ReactNode
  suggestion?: CommentSuggestionOptions
}

export function ReviewThreadCommentBlock({
  body,
  author,
  createdAtLabel,
  url,
  isPending,
  reactions,
  metaPrefix,
  metaActions,
  suggestion
}: ReviewThreadCommentBlockProps): React.JSX.Element {
  return (
    <div className="orca-review-thread-comment">
      <div className="orca-diff-comment-header">
        <div className="orca-diff-comment-meta-group">
          {metaPrefix}
          {[author, createdAtLabel].filter(Boolean).join(' ')}
          {isPending ? (
            <span className="orca-review-thread-pending-badge">
              {translate(
                'auto.components.diff.comments.ReviewThreadCommentBlock.pendingBadge',
                'Pending'
              )}
            </span>
          ) : null}
        </div>
        <div className="orca-diff-comment-actions-pill" onMouseDown={(ev) => ev.stopPropagation()}>
          {metaActions}
          {url ? (
            <button
              type="button"
              className="orca-diff-comment-pill-btn"
              title={translate(
                'auto.components.diff.comments.ReviewThreadCommentBlock.openInBrowser',
                'Open in browser'
              )}
              aria-label={translate(
                'auto.components.diff.comments.ReviewThreadCommentBlock.openInBrowser',
                'Open in browser'
              )}
              onClick={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                void window.api.shell.openUrl(url)
              }}
            >
              {translate(
                'auto.components.diff.comments.ReviewThreadCommentBlock.openAction',
                'Open'
              )}
            </button>
          ) : null}
        </div>
      </div>

      <CommentMarkdown
        content={body}
        variant="compact"
        className="orca-review-thread-body"
        suggestion={suggestion}
      />

      {reactions?.some((r) => r.count > 0) ? (
        <CommentReactions reactions={reactions} className="mt-1" />
      ) : null}
    </div>
  )
}

import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CommentSuggestionOptions } from '@/components/sidebar/comment-suggestion-fence'
import { getDiffCommentLineLabel } from '@/lib/diff-comment-compat'
import { translate } from '@/i18n/i18n'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import { ReviewThreadCommentBlock } from './ReviewThreadCommentBlock'
import {
  reviewThreadCommentCountLabel,
  reviewThreadExpandResolvedLabel
} from './review-thread-copy'

// Why: hosted-review threads render inside a Monaco view zone's own React
// root (like DiffCommentCard), so this card must be self-contained: markdown,
// replies, and collapse state all live here — app-level context providers do
// not reach zone roots. Read-only: mutations stay on github.com.

export type ReviewThreadCardProps = {
  comment: DecoratedDiffComment
  onContentResize: () => void
}

export function ReviewThreadCard({
  comment,
  onContentResize
}: ReviewThreadCardProps): React.JSX.Element {
  const reviewThread = comment.reviewThread
  const isResolved = reviewThread?.isResolved === true
  const replies = reviewThread?.replies ?? []
  const [expanded, setExpanded] = useState(!isResolved)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Why: stash onContentResize in a ref so the observer effect survives the
  // decorator's fresh arrow each render without re-attaching.
  const onContentResizeRef = useRef(onContentResize)
  onContentResizeRef.current = onContentResize

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) {
      return
    }
    onContentResizeRef.current()
    let frameId: number | null = null
    const notifyResize = (): void => {
      if (frameId !== null) {
        return
      }
      frameId = requestAnimationFrame(() => {
        frameId = null
        onContentResizeRef.current()
      })
    }
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frameId !== null) {
          cancelAnimationFrame(frameId)
        }
      }
    }
    // Why: markdown bodies and reply lists wrap unpredictably in narrow diff
    // panes; the view zone's fixed height must follow the real card height.
    const observer = new ResizeObserver(() => notifyResize())
    observer.observe(card)
    return () => {
      observer.disconnect()
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [])

  useLayoutEffect(() => {
    // Why: expansion/collapse changes the card height in the same commit;
    // nudge the zone before the observer's next frame.
    onContentResizeRef.current()
  }, [expanded, replies.length])

  // Why: mirror github.com — a background refresh that flips resolution
  // collapses or reopens the thread instead of freezing its mount-time state.
  useEffect(() => {
    setExpanded(!isResolved)
  }, [isResolved])

  // Why: even without resolved target lines (outdated threads, still-loading
  // content) a ```suggestion fence must render as a preview, not a code block.
  const suggestionOptions = useMemo(
    (): CommentSuggestionOptions => ({ originalLines: comment.suggestionTargetLines }),
    [comment.suggestionTargetLines]
  )

  // Why: file-level threads carry lineNumber 0 — "line 0" would be a lie.
  const lineLabel =
    comment.lineNumber >= 1
      ? getDiffCommentLineLabel({
          lineNumber: comment.lineNumber,
          startLine: comment.startLine
        }).toLowerCase()
      : ''
  const commentCount = replies.length + 1

  if (!expanded) {
    return (
      <div ref={cardRef} className="orca-diff-comment-card">
        <button
          type="button"
          className="orca-review-thread-collapsed-row"
          aria-label={reviewThreadExpandResolvedLabel(commentCount)}
          onClick={(ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            setExpanded(true)
          }}
        >
          <CheckCircle2 className="size-3.5 orca-review-thread-resolved-icon" />
          <span className="orca-review-thread-resolved-badge">
            {translate('auto.components.diff.comments.ReviewThreadCard.resolvedBadge', 'Resolved')}
          </span>
          <span className="orca-diff-comment-meta-group">
            {[comment.author, lineLabel].filter(Boolean).join(' ')}
          </span>
          <span className="orca-review-thread-count">
            {reviewThreadCommentCountLabel(commentCount)}
          </span>
          <ChevronRight className="ml-auto size-3.5 opacity-60" />
        </button>
      </div>
    )
  }

  return (
    <div ref={cardRef} className="orca-diff-comment-card">
      <div className="orca-diff-comment-content-col">
        <ReviewThreadCommentBlock
          body={comment.body}
          author={comment.author}
          createdAtLabel={comment.createdAtLabel}
          url={comment.url}
          isPending={comment.isPendingReview}
          reactions={comment.reactions}
          suggestion={suggestionOptions}
          metaPrefix={
            <>
              {isResolved ? (
                <span className="orca-review-thread-resolved-badge mr-1">
                  <CheckCircle2 className="mr-0.5 inline size-3 orca-review-thread-resolved-icon" />
                  {translate(
                    'auto.components.diff.comments.ReviewThreadCard.resolvedBadge',
                    'Resolved'
                  )}
                </span>
              ) : null}
              <span className="text-muted-foreground">{lineLabel}</span>
            </>
          }
          metaActions={
            isResolved ? (
              <button
                type="button"
                className="orca-diff-comment-pill-btn"
                title={translate(
                  'auto.components.diff.comments.ReviewThreadCard.collapseThread',
                  'Collapse resolved conversation'
                )}
                aria-label={translate(
                  'auto.components.diff.comments.ReviewThreadCard.collapseThread',
                  'Collapse resolved conversation'
                )}
                onClick={(ev) => {
                  ev.preventDefault()
                  ev.stopPropagation()
                  setExpanded(false)
                }}
              >
                <ChevronDown className="size-3" />
              </button>
            ) : null
          }
        />

        {replies.length > 0 ? (
          <div className="orca-review-thread-replies">
            {replies.map((reply) => (
              <ReviewThreadCommentBlock
                key={reply.id}
                body={reply.body}
                author={reply.author}
                createdAtLabel={reply.createdAtLabel}
                url={reply.url}
                isPending={reply.isPending}
                reactions={reply.reactions}
                suggestion={suggestionOptions}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

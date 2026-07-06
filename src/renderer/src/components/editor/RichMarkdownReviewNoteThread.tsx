import { useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import type { DiffCommentReply } from '../../../../shared/types'
import { formatReviewNoteTimestamp } from '@/lib/markdown-review-note-time'
import { translate } from '@/i18n/i18n'

type RichMarkdownReviewNoteThreadProps = {
  replies: readonly DiffCommentReply[]
  /** Returns true when the reply persisted. The thread clears the input
   *  optimistically and restores the draft when this resolves false/throws. */
  onAddReply: (body: string) => Promise<boolean>
  onContentResize: () => void
}

export function RichMarkdownReviewNoteThread({
  replies,
  onAddReply,
  onContentResize
}: RichMarkdownReviewNoteThreadProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const trimmed = draft.trim()

  const submit = async (): Promise<void> => {
    if (!trimmed || submitting) {
      return
    }
    setSubmitting(true)
    // Why: clear the input immediately so the reply feels instant — the store
    // update is optimistic, so the new reply renders on the next frame. Restore
    // the draft only if the persist actually fails, so text is never lost.
    const pending = trimmed
    setDraft('')
    try {
      const ok = await onAddReply(pending)
      if (!ok) {
        setDraft(pending)
      }
    } catch {
      setDraft(pending)
    } finally {
      setSubmitting(false)
      onContentResize()
    }
  }

  return (
    <div className="rich-markdown-review-thread">
      {replies.length > 0 ? (
        <ul className="rich-markdown-review-reply-list">
          {replies.map((reply) => (
            <li
              key={reply.id}
              className={`rich-markdown-review-reply rich-markdown-review-reply--${reply.authorRole}`}
            >
              <div className="rich-markdown-review-reply-meta">
                <span className="rich-markdown-review-reply-author">
                  {reply.authorRole === 'agent'
                    ? translate(
                        'auto.components.editor.RichMarkdownReviewNoteThread.2bf33695c2',
                        'Agent'
                      )
                    : translate(
                        'auto.components.editor.RichMarkdownReviewNoteThread.88270bb163',
                        'You'
                      )}
                </span>
                <span className="rich-markdown-review-reply-time">
                  {formatReviewNoteTimestamp(reply.createdAt)}
                </span>
              </div>
              <span className="rich-markdown-review-reply-body">{reply.body}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="rich-markdown-review-reply-compose">
        <input
          type="text"
          className="rich-markdown-review-reply-input"
          value={draft}
          placeholder={translate(
            'auto.components.editor.RichMarkdownReviewNoteThread.665b0d63d1',
            'Reply…'
          )}
          onMouseDown={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <button
          type="button"
          className="rich-markdown-review-note-action"
          disabled={!trimmed || submitting}
          title={translate(
            'auto.components.editor.RichMarkdownReviewNoteThread.4994dba39d',
            'Send reply'
          )}
          aria-label={translate(
            'auto.components.editor.RichMarkdownReviewNoteThread.4994dba39d',
            'Send reply'
          )}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void submit()}
        >
          <CornerDownLeft className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

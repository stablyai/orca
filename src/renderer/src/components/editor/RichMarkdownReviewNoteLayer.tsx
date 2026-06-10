import { Check, Copy } from 'lucide-react'
import type { DiffComment } from '../../../../shared/types'
import { DiffCommentCard } from '../diff-comments/DiffCommentCard'
import { NotesSendMenu } from './NotesSendMenu'
import {
  formatMarkdownReviewNotes,
  getMarkdownReviewCardQuote,
  type MarkdownReviewNote
} from '@/lib/markdown-review-notes'
import type { RichMarkdownReviewNotePosition } from './rich-markdown-review-note-layout'
import { translate } from '@/i18n/i18n'

function isRichMarkdownReviewNoteNavigationClick(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return !target.closest('button,input,textarea,select,a,[contenteditable="true"]')
}

type RichMarkdownReviewNoteLayerProps = {
  positions: RichMarkdownReviewNotePosition[]
  activeCommentId: string | null
  attentionCommentId: string | null
  copiedCommentId: string | null
  markdownReviewContent: string
  worktreeId: string
  filePath: string
  onCopyNote: (note: MarkdownReviewNote) => void
  onScrollSourceIntoView: (comment: DiffComment) => void
  onDeleteComment: (commentId: string) => void
  onSubmitEdit: (commentId: string, body: string) => Promise<boolean>
  onContentResize: () => void
  onDelivered: (notes: readonly MarkdownReviewNote[]) => void
}

export function RichMarkdownReviewNoteLayer({
  positions,
  activeCommentId,
  attentionCommentId,
  copiedCommentId,
  markdownReviewContent,
  worktreeId,
  filePath,
  onCopyNote,
  onScrollSourceIntoView,
  onDeleteComment,
  onSubmitEdit,
  onContentResize,
  onDelivered
}: RichMarkdownReviewNoteLayerProps): React.JSX.Element {
  return (
    <div
      className="rich-markdown-review-note-layer"
      aria-label={translate(
        'auto.components.editor.RichMarkdownReviewNoteLayer.3ababd949d',
        'Review notes'
      )}
    >
      {positions.map(({ comment, top }) => (
        <div
          key={comment.id}
          data-rich-markdown-review-note-id={comment.id}
          className={`rich-markdown-review-note-card ${
            activeCommentId === comment.id ? 'is-active' : ''
          } ${attentionCommentId === comment.id ? 'is-attention' : ''}`.trim()}
          style={{ top }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            if (!isRichMarkdownReviewNoteNavigationClick(event.target)) {
              return
            }
            onScrollSourceIntoView(comment)
          }}
        >
          <DiffCommentCard
            lineNumber={comment.lineNumber}
            startLine={comment.startLine}
            label={null}
            quote={getMarkdownReviewCardQuote(markdownReviewContent, comment)}
            body={comment.body}
            sentAt={comment.sentAt}
            onDelete={() => onDeleteComment(comment.id)}
            onSubmitEdit={(body) => onSubmitEdit(comment.id, body)}
            onContentResize={onContentResize}
            headerActions={
              <>
                <button
                  type="button"
                  className="rich-markdown-review-note-action"
                  title={
                    copiedCommentId === comment.id
                      ? translate(
                          'auto.components.editor.RichMarkdownReviewNoteLayer.117432e2c6',
                          'Copied note'
                        )
                      : translate(
                          'auto.components.editor.RichMarkdownReviewNoteLayer.9cde7ad994',
                          'Copy note for agent'
                        )
                  }
                  aria-label={
                    copiedCommentId === comment.id
                      ? translate(
                          'auto.components.editor.RichMarkdownReviewNoteLayer.117432e2c6',
                          'Copied note'
                        )
                      : translate(
                          'auto.components.editor.RichMarkdownReviewNoteLayer.9cde7ad994',
                          'Copy note for agent'
                        )
                  }
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onCopyNote(comment as MarkdownReviewNote)
                  }}
                >
                  {copiedCommentId === comment.id ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
                <NotesSendMenu
                  worktreeId={worktreeId}
                  groupId={worktreeId}
                  modeIdParts={['markdown-notes', worktreeId, filePath, 'note', comment.id]}
                  scopes={[
                    {
                      id: 'note',
                      label: translate(
                        'auto.components.editor.RichMarkdownReviewNoteLayer.f3ef92952b',
                        'This note'
                      ),
                      notes: comment.sentAt ? [] : [comment as MarkdownReviewNote],
                      prompt: formatMarkdownReviewNotes(
                        [comment as MarkdownReviewNote],
                        markdownReviewContent
                      )
                    }
                  ]}
                  targetModeLabel="This note"
                  triggerClassName="rich-markdown-review-note-action"
                  disabledTooltip="Note already sent"
                  onDelivered={onDelivered}
                />
              </>
            }
          />
        </div>
      ))}
    </div>
  )
}

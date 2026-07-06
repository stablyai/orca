import { useMemo } from 'react'
import { Check, CircleCheck, Copy, RotateCcw } from 'lucide-react'
import type { DiffComment } from '../../../../shared/types'
import { DiffCommentCard } from '../diff-comments/DiffCommentCard'
import { NotesSendMenu } from './NotesSendMenu'
import { RichMarkdownReviewNoteThread } from './RichMarkdownReviewNoteThread'
import {
  formatMarkdownReviewNotes,
  getMarkdownReviewCardQuote,
  type MarkdownReviewNote
} from '@/lib/markdown-review-notes'
import type { RichMarkdownReviewNotePosition } from './rich-markdown-review-note-layout'
import { formatReviewNoteTimestamp } from '@/lib/markdown-review-note-time'
import { useAppStore } from '@/store'
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
  const resolveDiffComment = useAppStore((s) => s.resolveDiffComment)
  const addDiffCommentReply = useAppStore((s) => s.addDiffCommentReply)
  // Why: positions are a measured snapshot, so they hold a comment by value.
  // Read the live comment by id for card content (body/replies/resolved/sent)
  // so an optimistic reply or resolve renders immediately, without waiting for
  // the next position re-measure. The snapshot still owns the vertical anchor.
  const liveComments = useAppStore((s) => s.getDiffComments(worktreeId))
  const liveCommentsById = useMemo(
    () => new Map(liveComments.map((comment) => [comment.id, comment])),
    [liveComments]
  )
  return (
    <div
      className="rich-markdown-review-note-layer"
      aria-label={translate(
        'auto.components.editor.RichMarkdownReviewNoteLayer.3ababd949d',
        'Review notes'
      )}
    >
      {positions.map(({ comment: positionComment, top }) => {
        const comment = liveCommentsById.get(positionComment.id) ?? positionComment
        return (
          <div
            key={comment.id}
            data-rich-markdown-review-note-id={comment.id}
            className={`rich-markdown-review-note-card ${
              activeCommentId === comment.id ? 'is-active' : ''
            } ${attentionCommentId === comment.id ? 'is-attention' : ''} ${
              comment.resolvedAt ? 'is-resolved' : ''
            }`.trim()}
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
              author={
                comment.authorRole === 'agent'
                  ? translate(
                      'auto.components.editor.RichMarkdownReviewNoteLayer.cd102ad42c',
                      'Agent'
                    )
                  : undefined
              }
              createdAtLabel={formatReviewNoteTimestamp(comment.createdAt)}
              onDelete={() => onDeleteComment(comment.id)}
              onSubmitEdit={(body) => onSubmitEdit(comment.id, body)}
              onContentResize={onContentResize}
              footer={
                <RichMarkdownReviewNoteThread
                  replies={comment.replies ?? []}
                  onAddReply={async (body) => {
                    const reply = await addDiffCommentReply(worktreeId, comment.id, {
                      body,
                      authorRole: 'user'
                    })
                    return reply !== null
                  }}
                  onContentResize={onContentResize}
                />
              }
              headerActions={
                <>
                  <button
                    type="button"
                    className="rich-markdown-review-note-action"
                    title={
                      comment.resolvedAt
                        ? translate(
                            'auto.components.editor.RichMarkdownReviewNoteLayer.3695b489ca',
                            'Reopen note'
                          )
                        : translate(
                            'auto.components.editor.RichMarkdownReviewNoteLayer.004e3fa53a',
                            'Resolve note'
                          )
                    }
                    aria-label={
                      comment.resolvedAt
                        ? translate(
                            'auto.components.editor.RichMarkdownReviewNoteLayer.3695b489ca',
                            'Reopen note'
                          )
                        : translate(
                            'auto.components.editor.RichMarkdownReviewNoteLayer.004e3fa53a',
                            'Resolve note'
                          )
                    }
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void resolveDiffComment(worktreeId, comment.id, !comment.resolvedAt)
                    }}
                  >
                    {comment.resolvedAt ? (
                      <RotateCcw className="size-3.5" />
                    ) : (
                      <CircleCheck className="size-3.5" />
                    )}
                  </button>
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
        )
      })}
    </div>
  )
}

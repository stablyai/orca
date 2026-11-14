import { Check, Copy, MessageSquare } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NotesSendMenu } from '../../review-note-delivery/NotesSendMenu'
import type { MarkdownPreviewFoundation } from '../surface/use-markdown-preview-foundation'
import type { MarkdownPreviewReviewActions } from './use-markdown-preview-review-actions'

export function MarkdownPreviewReviewToolbar({
  foundation,
  reviewActions,
  filePath
}: {
  foundation: MarkdownPreviewFoundation
  reviewActions: MarkdownPreviewReviewActions
  filePath: string
}): React.JSX.Element {
  const t = useTranslate()
  const {
    markdownReviewNotes,
    reviewNotesCopied,
    commentOwner,
    notesKnown,
    sourceWorktree,
    unsentMarkdownReviewScope,
    clearDeliveredDiffComments
  } = foundation
  const { scrollToReviewNote, handleCopyMarkdownReviewNotes } = reviewActions

  return (
    <div className="markdown-review-toolbar">
      <button
        type="button"
        className="markdown-review-toolbar-button"
        onClick={() => {
          const firstNote = markdownReviewNotes[0]
          if (firstNote) {
            scrollToReviewNote(firstNote)
          }
        }}
        disabled={markdownReviewNotes.length === 0}
        title={t('auto.components.editor.MarkdownPreview.0f9969a159', 'Jump to first review note')}
        aria-label={t(
          'auto.components.editor.MarkdownPreview.0f9969a159',
          'Jump to first review note'
        )}
      >
        <MessageSquare className="size-3.5" />
        <span>{t('auto.components.editor.MarkdownPreview.322afab6ff', 'Review notes')}</span>
        <span className="markdown-review-count">{markdownReviewNotes.length}</span>
      </button>
      <button
        type="button"
        className="markdown-review-icon-button"
        onClick={() => void handleCopyMarkdownReviewNotes()}
        disabled={markdownReviewNotes.length === 0}
        title={t('auto.components.editor.MarkdownPreview.bb629de58a', 'Copy notes for agent')}
        aria-label={t('auto.components.editor.MarkdownPreview.bb629de58a', 'Copy notes for agent')}
      >
        {reviewNotesCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {sourceWorktree ? (
        <NotesSendMenu
          // Until the shown copy is listed its notes are unknown, not all sent.
          owner={notesKnown ? commentOwner : null}
          worktreeId={sourceWorktree.id}
          groupId={sourceWorktree.id}
          modeIdParts={['markdown-notes', sourceWorktree.id, filePath, 'preview-toolbar']}
          scopes={unsentMarkdownReviewScope}
          triggerClassName="markdown-review-icon-button"
          onDelivered={(notes) =>
            void (commentOwner && clearDeliveredDiffComments(commentOwner, notes))
          }
        />
      ) : null}
    </div>
  )
}

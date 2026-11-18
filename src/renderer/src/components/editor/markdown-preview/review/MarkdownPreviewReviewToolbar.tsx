import { MessageSquare } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NotesSendMenu } from '../../review-note-delivery/NotesSendMenu'
import {
  diffNotesClearRequest,
  NotesMenuCopyClearItems,
  useClearNotesConfirm
} from '../../review-note-delivery/notes-copy-clear'
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
    commentOwner,
    notesKnown,
    sourceWorktree,
    unsentMarkdownReviewScope,
    clearDeliveredDiffComments
  } = foundation
  const { scrollToReviewNote, handleCopyMarkdownReviewNotes } = reviewActions
  const clearConfirm = useClearNotesConfirm()

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
      </button>
      {sourceWorktree ? (
        <NotesSendMenu
          // Until the shown copy is listed its notes are unknown, not all sent.
          owner={notesKnown ? commentOwner : null}
          worktreeId={sourceWorktree.id}
          groupId={sourceWorktree.id}
          modeIdParts={['markdown-notes', sourceWorktree.id, filePath, 'preview-toolbar']}
          scopes={unsentMarkdownReviewScope}
          batchTrigger={{}}
          menuFooter={
            commentOwner ? (
              <NotesMenuCopyClearItems
                onCopy={() => void handleCopyMarkdownReviewNotes()}
                onClear={() =>
                  clearConfirm.requestClear(
                    diffNotesClearRequest(commentOwner, markdownReviewNotes, filePath)
                  )
                }
              />
            ) : null
          }
          onDelivered={(notes) =>
            void (commentOwner && clearDeliveredDiffComments(commentOwner, notes))
          }
        />
      ) : null}
      {clearConfirm.dialog}
    </div>
  )
}

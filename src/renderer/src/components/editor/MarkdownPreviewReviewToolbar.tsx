import { Check, Copy, MessageSquare } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { NotesSendMenu } from './NotesSendMenu'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
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
  const {
    markdownReviewNotes,
    reviewNotesCopied,
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
        title={translate(
          'auto.components.editor.MarkdownPreview.0f9969a159',
          'Jump to first review note'
        )}
        aria-label={translate(
          'auto.components.editor.MarkdownPreview.0f9969a159',
          'Jump to first review note'
        )}
      >
        <MessageSquare className="size-3.5" />
        <span>
          {translate('auto.components.editor.MarkdownPreview.322afab6ff', 'Review notes')}
        </span>
        <span className="markdown-review-count">{markdownReviewNotes.length}</span>
      </button>
      <button
        type="button"
        className="markdown-review-icon-button"
        onClick={() => void handleCopyMarkdownReviewNotes()}
        disabled={markdownReviewNotes.length === 0}
        title={translate(
          'auto.components.editor.MarkdownPreview.bb629de58a',
          'Copy notes for agent'
        )}
        aria-label={translate(
          'auto.components.editor.MarkdownPreview.bb629de58a',
          'Copy notes for agent'
        )}
      >
        {reviewNotesCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {sourceWorktree ? (
        <NotesSendMenu
          worktreeId={sourceWorktree.id}
          groupId={sourceWorktree.id}
          modeIdParts={['markdown-notes', sourceWorktree.id, filePath, 'preview-toolbar']}
          scopes={unsentMarkdownReviewScope}
          triggerClassName="markdown-review-icon-button"
          onDelivered={(notes) => void clearDeliveredDiffComments(sourceWorktree.id, notes)}
        />
      ) : null}
    </div>
  )
}

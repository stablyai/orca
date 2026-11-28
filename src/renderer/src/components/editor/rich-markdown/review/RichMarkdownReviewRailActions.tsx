import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import { MessageSquare } from 'lucide-react'
import { NotesSendMenu, type NotesSendMenuScope } from '../../review-note-delivery/NotesSendMenu'
import {
  diffNotesClearRequest,
  NotesMenuCopyClearItems,
  useClearNotesConfirm
} from '../../review-note-delivery/notes-copy-clear'
import type { MarkdownReviewNote } from '@/lib/editor/markdown/review-notes/markdown-review-notes'
import { SendNotesSlot } from '../../review-note-delivery/SendNotesButton'
import { useTranslate } from '@/i18n/use-translate'

type RichMarkdownReviewRailActionsProps = {
  owner: DiffCommentOwner | null
  worktreeId: string
  filePath: string
  notes: readonly { id: string }[]
  railOpen: boolean
  unsentScope: NotesSendMenuScope<MarkdownReviewNote>[]
  onToggleRail: () => void
  onCopyNotes: () => void
  onDelivered: (notes: readonly MarkdownReviewNote[]) => void
}

export function RichMarkdownReviewRailActions({
  owner,
  worktreeId,
  filePath,
  notes,
  railOpen,
  unsentScope,
  onToggleRail,
  onCopyNotes,
  onDelivered
}: RichMarkdownReviewRailActionsProps): React.JSX.Element {
  const t = useTranslate()
  const clearConfirm = useClearNotesConfirm()
  return (
    <>
      {notes.length > 0 ? (
        <div className="rich-markdown-review-rail-actions">
          <button
            type="button"
            className="rich-markdown-review-rail-toggle"
            aria-label={
              railOpen
                ? t(
                    'auto.components.editor.RichMarkdownReviewRailActions.af02dc2456',
                    'Hide review notes'
                  )
                : t(
                    'auto.components.editor.RichMarkdownReviewRailActions.8aaf2c4c69',
                    'Show review notes'
                  )
            }
            aria-expanded={railOpen}
            title={
              railOpen
                ? t(
                    'auto.components.editor.RichMarkdownReviewRailActions.af02dc2456',
                    'Hide review notes'
                  )
                : t(
                    'auto.components.editor.RichMarkdownReviewRailActions.8aaf2c4c69',
                    'Show review notes'
                  )
            }
            onClick={onToggleRail}
          >
            <MessageSquare className="size-3.5" />
            <span>{notes.length}</span>
          </button>
          <SendNotesSlot fitContent>
            <NotesSendMenu
              owner={owner}
              worktreeId={worktreeId}
              groupId={worktreeId}
              modeIdParts={['markdown-notes', worktreeId, filePath, 'rail']}
              scopes={unsentScope}
              batchTrigger={{}}
              menuFooter={
                owner ? (
                  <NotesMenuCopyClearItems
                    onCopy={onCopyNotes}
                    onClear={() =>
                      clearConfirm.requestClear(diffNotesClearRequest(owner, notes, filePath))
                    }
                  />
                ) : null
              }
              onDelivered={onDelivered}
            />
          </SendNotesSlot>
        </div>
      ) : null}
      {clearConfirm.dialog}
    </>
  )
}

import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import { Check, Copy, MessageSquare } from 'lucide-react'
import { NotesSendMenu, type NotesSendMenuScope } from '../../review-note-delivery/NotesSendMenu'
import type { MarkdownReviewNote } from '@/lib/editor/markdown/review-notes/markdown-review-notes'
import { useTranslate } from '@/i18n/use-translate'

type RichMarkdownReviewRailActionsProps = {
  owner: DiffCommentOwner | null
  worktreeId: string
  filePath: string
  noteCount: number
  railOpen: boolean
  notesCopied: boolean
  unsentScope: NotesSendMenuScope<MarkdownReviewNote>[]
  onToggleRail: () => void
  onCopyNotes: () => void
  onDelivered: (notes: readonly MarkdownReviewNote[]) => void
}

export function RichMarkdownReviewRailActions({
  owner,
  worktreeId,
  filePath,
  noteCount,
  railOpen,
  notesCopied,
  unsentScope,
  onToggleRail,
  onCopyNotes,
  onDelivered
}: RichMarkdownReviewRailActionsProps): React.JSX.Element {
  const t = useTranslate()
  return (
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
        <span>{noteCount}</span>
      </button>
      <button
        type="button"
        className="rich-markdown-review-rail-action"
        title={
          notesCopied
            ? t('auto.components.editor.RichMarkdownReviewRailActions.a807596997', 'Copied notes')
            : t(
                'auto.components.editor.RichMarkdownReviewRailActions.636394af72',
                'Copy notes for agent'
              )
        }
        aria-label={
          notesCopied
            ? t('auto.components.editor.RichMarkdownReviewRailActions.a807596997', 'Copied notes')
            : t(
                'auto.components.editor.RichMarkdownReviewRailActions.636394af72',
                'Copy notes for agent'
              )
        }
        onClick={onCopyNotes}
      >
        {notesCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <NotesSendMenu
        owner={owner}
        worktreeId={worktreeId}
        groupId={worktreeId}
        modeIdParts={['markdown-notes', worktreeId, filePath, 'rail']}
        scopes={unsentScope}
        triggerClassName="rich-markdown-review-rail-action"
        onDelivered={onDelivered}
      />
    </div>
  )
}

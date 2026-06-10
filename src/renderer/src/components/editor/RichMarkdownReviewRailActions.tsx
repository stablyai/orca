import { Check, Copy, MessageSquare } from 'lucide-react'
import { NotesSendMenu, type NotesSendMenuScope } from './NotesSendMenu'
import type { MarkdownReviewNote } from '@/lib/markdown-review-notes'
import { translate } from '@/i18n/i18n'

type RichMarkdownReviewRailActionsProps = {
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
  return (
    <div className="rich-markdown-review-rail-actions">
      <button
        type="button"
        className="rich-markdown-review-rail-toggle"
        aria-label={
          railOpen
            ? translate(
                'auto.components.editor.RichMarkdownReviewRailActions.af02dc2456',
                'Hide review notes'
              )
            : translate(
                'auto.components.editor.RichMarkdownReviewRailActions.8aaf2c4c69',
                'Show review notes'
              )
        }
        aria-expanded={railOpen}
        title={
          railOpen
            ? translate(
                'auto.components.editor.RichMarkdownReviewRailActions.af02dc2456',
                'Hide review notes'
              )
            : translate(
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
            ? translate(
                'auto.components.editor.RichMarkdownReviewRailActions.a807596997',
                'Copied notes'
              )
            : translate(
                'auto.components.editor.RichMarkdownReviewRailActions.636394af72',
                'Copy notes for agent'
              )
        }
        aria-label={
          notesCopied
            ? translate(
                'auto.components.editor.RichMarkdownReviewRailActions.a807596997',
                'Copied notes'
              )
            : translate(
                'auto.components.editor.RichMarkdownReviewRailActions.636394af72',
                'Copy notes for agent'
              )
        }
        onClick={onCopyNotes}
      >
        {notesCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <NotesSendMenu
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

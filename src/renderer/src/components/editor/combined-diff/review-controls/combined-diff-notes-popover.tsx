import type React from 'react'
import { Check, Copy, MessageSquare, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { getDiffCommentLineLabel } from '@/lib/diff-comment-compat'
import { translate } from '@/i18n/i18n'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'

export function DiffNotesPreviewPopover({
  comments,
  totalCount,
  copied,
  onCopy,
  onClear
}: {
  comments: DiffComment[]
  totalCount: number
  copied: boolean
  onCopy: () => void
  onClear: () => void
}): React.JSX.Element {
  const remainingCount = Math.max(0, totalCount - comments.length)

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
          <span>
            {translate('auto.components.editor.CombinedDiffViewer.bb84b4c374', 'AI notes')}
          </span>
          <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
            {totalCount}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 text-muted-foreground hover:text-foreground"
            onClick={onCopy}
            disabled={totalCount === 0}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {translate('auto.components.editor.CombinedDiffViewer.88b70d0ef5', 'Copy')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 text-muted-foreground hover:text-destructive"
            onClick={onClear}
            disabled={totalCount === 0}
          >
            <Trash2 className="size-3" />
            {translate('auto.components.editor.CombinedDiffViewer.84898c548d', 'Clear')}
          </Button>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto p-2 scrollbar-sleek">
        {comments.map((comment) => (
          <div key={comment.id} className="rounded-md px-2 py-1.5 hover:bg-accent/50">
            <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
              <span className="min-w-0 flex-1 truncate font-mono">{comment.filePath}</span>
              {comment.sentAt ? (
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] leading-none">
                  {translate('auto.components.editor.CombinedDiffViewer.1da745c551', 'Sent')}
                </span>
              ) : null}
              <span className="shrink-0 tabular-nums">
                {getDiffCommentLineLabel(comment, true)}
              </span>
            </div>
            <div className="mt-1 max-h-10 overflow-hidden whitespace-pre-wrap break-words text-[12px] leading-snug text-foreground">
              {comment.body}
            </div>
          </div>
        ))}
        {remainingCount > 0 && (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            {remainingCount}{' '}
            {translate('auto.components.editor.CombinedDiffViewer.e3b9a6ce02', 'more')}
            {remainingCount === 1
              ? translate('auto.components.editor.CombinedDiffViewer.8ab3248fd8', 'note')
              : translate('auto.components.editor.CombinedDiffViewer.0fb870a0fe', 'notes')}{' '}
            {translate('auto.components.editor.CombinedDiffViewer.35cc27aeb2', 'in Source Control')}
          </div>
        )}
      </div>
    </div>
  )
}

export function ClearDiffNotesDialog({
  diffCommentCount,
  isClearingNotes,
  onConfirm,
  open,
  setOpen
}: {
  diffCommentCount: number
  isClearingNotes: boolean
  onConfirm: () => void
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isClearingNotes) {
          setOpen(false)
        } else if (nextOpen) {
          setOpen(true)
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.editor.CombinedDiffViewer.948a5fd6c8', 'Clear Notes')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate('auto.components.editor.CombinedDiffViewer.84898c548d', 'Clear')}{' '}
            {diffCommentCount}{' '}
            {diffCommentCount === 1
              ? translate('auto.components.editor.CombinedDiffViewer.8ab3248fd8', 'note')
              : translate('auto.components.editor.CombinedDiffViewer.0fb870a0fe', 'notes')}{' '}
            {translate(
              'auto.components.editor.CombinedDiffViewer.80a286d8f5',
              'from this worktree?'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isClearingNotes}
          >
            {translate('auto.components.editor.CombinedDiffViewer.0f806a2ab1', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={isClearingNotes || diffCommentCount === 0}
          >
            <Trash2 className="size-4" />
            {translate('auto.components.editor.CombinedDiffViewer.948a5fd6c8', 'Clear Notes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

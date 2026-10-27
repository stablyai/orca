import { useMemo, useRef } from 'react'
import { Trash, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiscardAllArea } from '../../../../../../shared/source-control-discard-all-sequence'
import {
  getDiscardAreaConfirmationCopy,
  getDiscardEntryConfirmationCopy
} from './discard-confirmation'
import { translate } from '@/i18n/i18n'

export type PendingDiscardConfirmation =
  | { kind: 'entry'; entry: GitStatusEntry }
  | { kind: 'area'; area: DiscardAllArea; paths: readonly string[] }

export function focusDiscardDialogConfirmButton(
  event: Event,
  confirmButton: HTMLButtonElement | null
): void {
  if (!confirmButton) {
    return
  }
  // Override Radix's initial Cancel focus so Enter confirms this destructive action.
  event.preventDefault()
  confirmButton.focus()
}

export function SourceControlDiscardDialog({
  pendingDiscard,
  onCancel,
  onConfirm
}: {
  pendingDiscard: PendingDiscardConfirmation | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const pendingDiscardCopy = useMemo(() => {
    if (!pendingDiscard) {
      return null
    }
    if (pendingDiscard.kind === 'entry') {
      return getDiscardEntryConfirmationCopy(pendingDiscard.entry)
    }
    return getDiscardAreaConfirmationCopy(pendingDiscard.area, pendingDiscard.paths.length)
  }, [pendingDiscard])
  const PendingDiscardIcon = pendingDiscardCopy?.confirmLabel.startsWith('Delete') ? Trash : Undo2

  return (
    <Dialog
      open={pendingDiscard !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) =>
          focusDiscardDialogConfirmButton(event, confirmButtonRef.current)
        }
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {pendingDiscardCopy?.title ??
              translate(
                'auto.components.right.sidebar.source.control.discard.dialog.1551c14668',
                'Discard changes?'
              )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {pendingDiscardCopy?.description ??
              translate(
                'auto.components.right.sidebar.source.control.discard.dialog.0d2d88cba5',
                'This cannot be undone.'
              )}
          </DialogDescription>
        </DialogHeader>
        {pendingDiscard?.kind === 'area' ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            {translate('sourceControl.discard.fileCount', '{{count}} files', {
              count: pendingDiscard.paths.length,
              defaultValue_one: '{{count}} file'
            })}
          </div>
        ) : pendingDiscard?.kind === 'entry' ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">{pendingDiscard.entry.path}</div>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {translate(
              'auto.components.right.sidebar.source.control.discard.dialog.3bc61dc989',
              'Cancel'
            )}
          </Button>
          <Button
            ref={confirmButtonRef}
            type="button"
            variant="destructive"
            autoFocus
            onClick={onConfirm}
          >
            <PendingDiscardIcon className="size-4" />
            {pendingDiscardCopy?.confirmLabel ??
              translate(
                'auto.components.right.sidebar.source.control.discard.dialog.15efa778e3',
                'Discard'
              )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

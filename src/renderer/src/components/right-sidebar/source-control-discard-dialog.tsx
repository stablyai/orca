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
import type { GitStatusEntry } from '../../../../shared/types'
import type { DiscardAllArea } from './discard-all-sequence'
import {
  getDiscardAreaConfirmationCopy,
  getDiscardEntryConfirmationCopy
} from './source-control-discard-confirmation'

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
  // Why: Radix otherwise focuses Cancel first, making Enter dismiss this destructive confirm.
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
            {pendingDiscardCopy?.title ?? 'Discard changes?'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {pendingDiscardCopy?.description ?? 'This cannot be undone.'}
          </DialogDescription>
        </DialogHeader>
        {pendingDiscard?.kind === 'area' ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            {pendingDiscard.paths.length} {pendingDiscard.paths.length === 1 ? 'file' : 'files'}
          </div>
        ) : pendingDiscard?.kind === 'entry' ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-medium text-foreground">{pendingDiscard.entry.path}</div>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirmButtonRef}
            type="button"
            variant="destructive"
            autoFocus
            onClick={onConfirm}
          >
            <PendingDiscardIcon className="size-4" />
            {pendingDiscardCopy?.confirmLabel ?? 'Discard'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

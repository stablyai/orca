import React, { useCallback, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type CollectionDeleteDialogProps = {
  open: boolean
  collectionName: string
  onOpenChange: (open: boolean) => void
  /** Returns whether the delete succeeded; the dialog stays open on failure. */
  onConfirm: () => Promise<boolean> | boolean
}

export function CollectionDeleteDialog({
  open,
  collectionName,
  onOpenChange,
  onConfirm
}: CollectionDeleteDialogProps): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const mountedRef = useRef(true)

  // Why: the parent keeps this mounted; if a close races the confirm's finally,
  // a stale `deleting` would dead-lock the buttons on the next open.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDeleting(false)
    }
  }

  const handleDialogContentRef = useCallback((node: HTMLDivElement | null): void => {
    mountedRef.current = node !== null
  }, [])

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (deleting) {
      return
    }
    setDeleting(true)
    try {
      const deleted = await onConfirm()
      if (deleted && mountedRef.current) {
        onOpenChange(false)
      }
    } finally {
      if (mountedRef.current) {
        setDeleting(false)
      }
    }
  }, [deleting, onConfirm, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={handleDialogContentRef} className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.sidebar.CollectionDeleteDialog.title',
              'Delete “{{value0}}”?',
              { value0: collectionName }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.CollectionDeleteDialog.description',
              'The collection disappears from the sidebar. Worktrees are not affected and stay in their projects.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={deleting}
            onClick={() => onOpenChange(false)}
          >
            {translate('auto.components.sidebar.CollectionDeleteDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting}
            onClick={() => void handleConfirm()}
          >
            {translate('auto.components.sidebar.CollectionDeleteDialog.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

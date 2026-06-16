import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

export function DockerConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void | Promise<void>
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const handleConfirm = async (): Promise<void> => {
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (error) {
      // onConfirm owns user-facing error display (toast); keep the dialog open for retry/dismiss.
      console.error('DockerConfirmDialog: confirm failed', error)
    } finally {
      setPending(false)
    }
  }
  // Why: a destructive op keeps running even if its confirmation UI is dismissed,
  // so block dismissal (Cancel, Esc, overlay) while it's in flight to avoid a
  // confusing state where the action completes after the dialog disappears.
  const handleOpenChange = (next: boolean): void => {
    if (pending && !next) {
      return
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {translate('auto.components.docker.DockerConfirmDialog.cc2263a02e', 'Cancel')}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => void handleConfirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

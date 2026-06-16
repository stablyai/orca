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
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
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

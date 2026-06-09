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

type ProjectGroupDeleteDialogProps = {
  open: boolean
  groupName: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void> | void
}

export function ProjectGroupDeleteDialog({
  open,
  groupName,
  onOpenChange,
  onConfirm
}: ProjectGroupDeleteDialogProps): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const mountedRef = useRef(true)

  const handleDialogContentRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: deleting can resolve after the dialog closes; the content ref keeps
    // late completions from mutating stale dialog state without an Effect.
    mountedRef.current = node !== null
  }, [])

  // Why: opening the dialog must clear a stale in-flight state before the
  // destructive button renders; an Effect would leave one disabled frame.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open && deleting) {
      setDeleting(false)
    }
  }

  const handleConfirm = useCallback(async () => {
    if (deleting) {
      return
    }
    setDeleting(true)
    try {
      await onConfirm()
      if (mountedRef.current) {
        setDeleting(false)
        onOpenChange(false)
      }
    } catch (error) {
      console.error('Failed to delete project group:', error)
      if (mountedRef.current) {
        setDeleting(false)
      }
    }
  }, [deleting, onConfirm, onOpenChange])

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setDeleting(false)
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        ref={handleDialogContentRef}
        className="max-w-sm sm:max-w-sm"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{translate("auto.components.sidebar.ProjectGroupDeleteDialog.591f330288", "Delete Project Group")}</DialogTitle>
          <DialogDescription className="text-xs">
            {translate("auto.components.sidebar.ProjectGroupDeleteDialog.69f5cb97d0", "Delete")}<span className="break-all font-medium text-foreground">{groupName}</span> {translate("auto.components.sidebar.ProjectGroupDeleteDialog.9be10d49ea", "and ungroup its projects.")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => onOpenChange(false)}
          >
            {translate("auto.components.sidebar.ProjectGroupDeleteDialog.ca65b78f78", "Cancel")}</Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="text-xs"
            disabled={deleting}
            onClick={handleConfirm}
          >
            {deleting ? translate("auto.components.sidebar.ProjectGroupDeleteDialog.2c14ce677a", "Deleting...") : translate("auto.components.sidebar.ProjectGroupDeleteDialog.69f5cb97d0", "Delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

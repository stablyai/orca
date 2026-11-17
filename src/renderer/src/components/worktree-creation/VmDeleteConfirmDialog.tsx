import type React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { useTranslate } from '@/i18n/use-translate'

/** Leaving a build that still holds a VM deletes it; ask first, wherever the leave came from. */
export function VmDeleteConfirmDialog({
  open,
  cloud,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  cloud: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm" surface="security" initialFocus="cancel">
        <DialogHeader>
          <DialogTitle>
            {cloud
              ? t(
                  'auto.components.worktree.creation.VmDeleteConfirmDialog.titleCloud',
                  'Delete this sandbox?'
                )
              : t(
                  'auto.components.worktree.creation.VmDeleteConfirmDialog.titleVm',
                  'Delete this VM?'
                )}
          </DialogTitle>
          <DialogDescription>
            {cloud
              ? t(
                  'auto.components.worktree.creation.VmDeleteConfirmDialog.bodyCloud',
                  'The sandbox and anything on it are deleted, and the workspace isn’t created.'
                )
              : t(
                  'auto.components.worktree.creation.VmDeleteConfirmDialog.bodyVm',
                  'The VM and anything on it are destroyed, and the workspace isn’t created.'
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogCancel>
            {t('auto.components.worktree.creation.VmDeleteConfirmDialog.keep', 'Keep')}
          </DialogCancel>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm}>
            {/* The title names the sandbox or VM; the button is the verb. */}
            {t('auto.components.worktree.creation.VmDeleteConfirmDialog.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

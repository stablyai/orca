import React, { useRef } from 'react'
import { Trash2 } from 'lucide-react'
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

type AutomationFolderDeleteDialogProps = {
  open: boolean
  folderName: string | null
  automationCount: number
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function AutomationFolderDeleteDialog({
  open,
  folderName,
  automationCount,
  onOpenChange,
  onConfirm
}: AutomationFolderDeleteDialogProps): React.JSX.Element {
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  // Why: deletion only unfiles members, it never deletes automations, so the
  // copy reports the move count instead of using delete/destructive language
  // about the automations themselves.
  const unfileNotice =
    automationCount === 0
      ? translate(
          'auto.components.automations.AutomationFolderDeleteDialog.noneAffected',
          'This folder has no automations.'
        )
      : automationCount === 1
        ? translate(
            'auto.components.automations.AutomationFolderDeleteDialog.oneUnfiled',
            '1 automation will be moved to Unfiled.'
          )
        : translate(
            'auto.components.automations.AutomationFolderDeleteDialog.manyUnfiled',
            '{{value0}} automations will be moved to Unfiled.',
            { value0: String(automationCount) }
          )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.automations.AutomationFolderDeleteDialog.title',
              'Delete Folder'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate('auto.components.automations.AutomationFolderDeleteDialog.delete', 'Delete')}{' '}
            <span className="break-all font-medium text-foreground">{folderName}</span>
            {'. '}
            {unfileNotice}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.automations.AutomationFolderDeleteDialog.cancel', 'Cancel')}
          </Button>
          <Button ref={confirmButtonRef} variant="destructive" onClick={onConfirm}>
            <Trash2 className="size-4" />
            {translate('auto.components.automations.AutomationFolderDeleteDialog.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

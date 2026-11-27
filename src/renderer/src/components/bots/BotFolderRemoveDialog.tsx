import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'

/** Removes only the folder; its bots and subfolders move to the parent. */
export function BotFolderRemoveDialog({
  open,
  folderName,
  parentName,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  folderName: string
  parentName: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="compact">
        <DialogHeader>
          <DialogTitle>{t('bots.folders.removeTitle', 'Remove folder')}</DialogTitle>
          <DialogDescription className="break-words">
            {t(
              'bots.folders.removeDescription',
              'Remove {{name}}? Its bots and subfolders move to {{parent}}.',
              { name: folderName, parent: parentName }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"

            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="button" size="sm" onClick={onConfirm}>
            {t('bots.folders.removeConfirm', 'Remove folder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

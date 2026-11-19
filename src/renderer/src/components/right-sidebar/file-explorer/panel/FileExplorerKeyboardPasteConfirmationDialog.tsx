import { useId, useState, type JSX } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'

export function FileExplorerKeyboardPasteConfirmationDialog({
  open,
  onCancel,
  onConfirm
}: {
  open: boolean
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): JSX.Element {
  const t = useTranslate()
  const checkboxId = useId()
  const [dontAskAgain, setDontAskAgain] = useState(false)

  const cancel = (): void => {
    setDontAskAgain(false)
    onCancel()
  }
  const confirm = (): void => {
    const savePreference = dontAskAgain
    setDontAskAgain(false)
    onConfirm(savePreference)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          cancel()
        }
      }}
    >
      <DialogContent size="confirm" initialFocus="cancel">
        <DialogHeader>
          <DialogTitle>
            {t(
              'auto.components.right.sidebar.FileExplorerKeyboardPaste.title',
              'Paste clipboard files into this folder?'
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.right.sidebar.FileExplorerKeyboardPaste.description',
              'The file explorer has focus. If you meant to paste into a terminal, click the terminal first.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter
          start={
            <div className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={dontAskAgain}
                onCheckedChange={(checked) => setDontAskAgain(checked === true)}
              />
              <Label htmlFor={checkboxId} variant="dialog-muted">
                {t(
                  'auto.components.right.sidebar.FileExplorerKeyboardPaste.dontAskAgain',
                  "Don't ask again"
                )}
              </Label>
            </div>
          }
        >
          <DialogCancel
            onClick={(event) => {
              event.preventDefault()
              cancel()
            }}
          >
            {t('auto.components.terminal.pane.CloseTerminalDialog.1d1a7a9c1f', 'Cancel')}
          </DialogCancel>
          <Button type="button" size="sm" onClick={confirm}>
            {t('auto.components.right.sidebar.FileExplorerPaste.paste', 'Paste')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

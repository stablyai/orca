import { useEffect, useId, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

/** Confirmation prompt shown when a pinned tab is about to be closed. Driven by
 *  store state so every close path (keyboard, native menu, CLI) can route a
 *  pinned tab through it without threading React context. */
export default function PinnedTabCloseDialog(): React.JSX.Element {
  const checkboxId = useId()
  const request = useAppStore((state) => state.pinnedTabCloseConfirm)
  const confirmPinnedTabClose = useAppStore((state) => state.confirmPinnedTabClose)
  const dismissPinnedTabClose = useAppStore((state) => state.dismissPinnedTabClose)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  const tabLabel = request?.tabLabel.trim()

  useEffect(() => {
    if (request !== null) {
      setDontAskAgain(false)
    }
  }, [request])

  const handleConfirm = (): void => {
    if (dontAskAgain) {
      void updateSettings({ confirmClosePinnedTab: false })
    }
    confirmPinnedTabClose()
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          dismissPinnedTabClose()
        }
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.terminal.pane.PinnedTabCloseDialog.6c190f295a',
              'Close pinned tab?'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.terminal.pane.PinnedTabCloseDialog.0d1963f4a6',
              'This tab is pinned. Are you sure you want to close it?'
            )}
          </DialogDescription>
        </DialogHeader>
        {tabLabel ? (
          <p className="truncate text-xs font-medium text-foreground" title={tabLabel}>
            {tabLabel}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={dontAskAgain}
            onCheckedChange={(checked) => setDontAskAgain(checked === true)}
          />
          <Label htmlFor={checkboxId} className="text-xs font-normal text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.PinnedTabCloseDialog.dont_ask_again',
              "Don't ask again for pinned tabs"
            )}
          </Label>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={dismissPinnedTabClose}>
            {translate('auto.components.terminal.pane.PinnedTabCloseDialog.0b38ee2f86', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive" size="sm" autoFocus onClick={handleConfirm}>
            {translate('auto.components.terminal.pane.PinnedTabCloseDialog.c337c9d75c', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useId, useState } from 'react'
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
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'

/** Store-driven confirmation lets keyboard, native menu and CLI closes share the pinned-tab guard outside React context. */
export default function PinnedTabCloseDialog(): React.JSX.Element {
  const t = useTranslate()
  const checkboxId = useId()
  const request = useAppStore((state) => state.pinnedTabCloseConfirm)
  const confirmPinnedTabClose = useAppStore((state) => state.confirmPinnedTabClose)
  const dismissPinnedTabClose = useAppStore((state) => state.dismissPinnedTabClose)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [previousRequest, setPreviousRequest] = useState(request)

  const tabLabel = request?.tabLabel.trim()
  const unsentNotes = request?.unsentNotes === true

  // Reset new requests before paint without reviving a cancelled request’s checkbox state.
  if (request !== previousRequest) {
    setPreviousRequest(request)
    if (request !== null) {
      setDontAskAgain(false)
    }
  }

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
            {unsentNotes
              ? t(
                  'auto.components.terminal.pane.PinnedTabCloseDialog.unsent_notes_title',
                  'Discard unsent notes?'
                )
              : t(
                  'auto.components.terminal.pane.PinnedTabCloseDialog.6c190f295a',
                  'Close pinned tab?'
                )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {unsentNotes
              ? t(
                  'auto.components.terminal.pane.PinnedTabCloseDialog.unsent_notes_description',
                  "This tab has notes you haven't sent. Closing it discards them."
                )
              : t(
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
        {unsentNotes ? null : (
          <div className="flex items-center gap-2">
            <Checkbox
              id={checkboxId}
              checked={dontAskAgain}
              onCheckedChange={(checked) => setDontAskAgain(checked === true)}
            />
            <Label htmlFor={checkboxId} className="text-xs font-normal text-muted-foreground">
              {t(
                'auto.components.terminal.pane.PinnedTabCloseDialog.dont_ask_again',
                "Don't ask again for pinned tabs"
              )}
            </Label>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={dismissPinnedTabClose}>
            {t('auto.components.terminal.pane.PinnedTabCloseDialog.0b38ee2f86', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive" size="sm" autoFocus onClick={handleConfirm}>
            {t('auto.components.terminal.pane.PinnedTabCloseDialog.c337c9d75c', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

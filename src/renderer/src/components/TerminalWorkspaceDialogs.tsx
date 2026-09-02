import { basename } from '../lib/path'
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
import type { TerminalController } from './use-terminal-controller'

export function TerminalWorkspaceDialogs({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element {
  const {
    confirmNativeWindowClose,
    handleSaveDialogCancel,
    handleSaveDialogDiscard,
    handleSaveDialogSave,
    saveDialogFile,
    saveDialogFileId,
    setWindowCloseDialogOpen,
    windowCloseDialogOpen
  } = controller
  return (
    <>
      <Dialog
        open={saveDialogFileId !== null}
        onOpenChange={(open) => {
          if (!open) {
            handleSaveDialogCancel()
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate('auto.components.Terminal.21295c6b8c', 'Unsaved Changes')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {saveDialogFile
                ? translate(
                    'auto.components.Terminal.61ed600d29',
                    '"{{value0}}" has unsaved changes. Do you want to save before closing?',
                    { value0: basename(saveDialogFile.relativePath) }
                  )
                : translate(
                    'auto.components.Terminal.46e08bc5c8',
                    'This file has unsaved changes.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogCancel}>
              {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogDiscard}>
              {translate('auto.components.Terminal.0037b21794', "Don't Save")}
            </Button>
            <Button type="button" size="sm" onClick={handleSaveDialogSave}>
              {translate('auto.components.Terminal.cd51e28d8b', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={windowCloseDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setWindowCloseDialogOpen(false)
          }
        }}
      >
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate('auto.components.Terminal.2fa9c69ff3', 'Close Window?')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.Terminal.7958465754',
                'There are local terminals with running processes. Close the window anyway?'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setWindowCloseDialogOpen(false)}
            >
              {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              autoFocus
              onClick={() => {
                setWindowCloseDialogOpen(false)
                confirmNativeWindowClose()
              }}
            >
              {translate('auto.components.Terminal.73768427cf', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

import { basename } from '../../../lib/path'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import {
  cancelWindowCloseRequest,
  confirmInteractiveWindowClose
} from '@/app-shell/shutdown/window-close-request-coordinator'
import type { TerminalController } from './use-terminal-controller'

export function TerminalWorkspaceDialogs({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element {
  const t = useTranslate()
  const {
    handleSaveDialogCancel,
    handleSaveDialogDiscard,
    handleSaveDialogSave,
    saveDialogFile,
    saveDialogFileId,
    setWindowCloseDialog,
    windowCloseDialog
  } = controller
  const cancelWindowClose = (): void => {
    if (windowCloseDialog) {
      setWindowCloseDialog(null)
      cancelWindowCloseRequest(windowCloseDialog.attempt)
    }
  }
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
              {t('auto.components.Terminal.21295c6b8c', 'Unsaved Changes')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {saveDialogFile
                ? t(
                    'auto.components.Terminal.61ed600d29',
                    '"{{value0}}" has unsaved changes. Do you want to save before closing?',
                    { value0: basename(saveDialogFile.relativePath) }
                  )
                : t('auto.components.Terminal.46e08bc5c8', 'This file has unsaved changes.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogCancel}>
              {t('auto.components.Terminal.f82e9f02df', 'Cancel')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDialogDiscard}>
              {t('auto.components.Terminal.0037b21794', "Don't Save")}
            </Button>
            <Button type="button" size="sm" onClick={handleSaveDialogSave}>
              {t('auto.components.Terminal.cd51e28d8b', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={windowCloseDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            cancelWindowClose()
          }
        }}
      >
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t('auto.components.Terminal.2fa9c69ff3', 'Close Window?')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {windowCloseDialog?.kind === 'unverifiable'
                ? t(
                    'auto.components.Terminal.b7c1f0a934',
                    'A remote host could not be reached, so Orca cannot tell whether work is still running there. Close the window anyway?'
                  )
                : t(
                    'auto.components.Terminal.93c2e9d845',
                    'There is running work in chats or terminals. Close the window anyway?'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={cancelWindowClose}>
              {t('auto.components.Terminal.f82e9f02df', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              autoFocus
              onClick={() => {
                if (windowCloseDialog) {
                  setWindowCloseDialog(null)
                  void confirmInteractiveWindowClose(windowCloseDialog.attempt)
                }
              }}
            >
              {t('auto.components.Terminal.73768427cf', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

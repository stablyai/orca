import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { useFloatingTerminalPanelController } from './use-floating-terminal-panel-controller'

type FloatingTerminalSaveDialogProps = Pick<
  ReturnType<typeof useFloatingTerminalPanelController>,
  | 'saveDialogFileId'
  | 'saveDialogFile'
  | 'handleFloatingSaveDialogCancel'
  | 'handleFloatingSaveDialogDiscard'
  | 'handleFloatingSaveDialogSave'
>

export function renderFloatingTerminalSaveDialog({
  saveDialogFileId,
  saveDialogFile,
  handleFloatingSaveDialogCancel,
  handleFloatingSaveDialogDiscard,
  handleFloatingSaveDialogSave
}: FloatingTerminalSaveDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={saveDialogFileId !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleFloatingSaveDialogCancel()
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.690b6fb98a',
              'Unsaved Changes'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {saveDialogFile
              ? translate(
                  'auto.components.floating.terminal.FloatingTerminalPanel.5ddc688c52',
                  '"{{value0}}" has unsaved changes. Do you want to save before closing?',
                  { value0: saveDialogFile.relativePath.split('/').pop() }
                )
              : translate(
                  'auto.components.floating.terminal.FloatingTerminalPanel.b085fb58b5',
                  'This file has unsaved changes.'
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleFloatingSaveDialogCancel}
          >
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.e7bf09d4d4',
              'Cancel'
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleFloatingSaveDialogDiscard}
          >
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.918c2139f3',
              "Don't Save"
            )}
          </Button>
          <Button type="button" size="sm" onClick={handleFloatingSaveDialogSave}>
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.da508bd7f5',
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

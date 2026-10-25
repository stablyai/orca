import { AlertCircle } from 'lucide-react'
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
import { isTerminalSessionStorageCapacityFailure } from '../../../../shared/terminal-session-state-save-failure'

export function TerminalSessionStateSaveFailureDialog({
  open,
  failureMessage,
  onDismiss,
  onOpenSpaceAnalyzer
}: {
  open: boolean
  failureMessage: string
  onDismiss: () => void
  onOpenSpaceAnalyzer: () => void
}): React.JSX.Element {
  const capacityFailure = isTerminalSessionStorageCapacityFailure(failureMessage)
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onDismiss()
        }
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
              <AlertCircle className="size-4 text-muted-foreground" />
            </div>
            <DialogTitle className="text-base">
              {translate('terminal.sessionSaveFailure.title', 'Could not save terminal session')}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs leading-5">
            {capacityFailure
              ? translate(
                  'terminal.sessionSaveFailure.capacity',
                  'The device saving this terminal reported full storage or an exceeded storage quota. Free space on that device, then try again.'
                )
              : translate(
                  'terminal.sessionSaveFailure.unknown',
                  'Orca could not save the terminal state. Try again. If this continues, share the Orca logs with support so we can identify the cause.'
                )}
          </DialogDescription>
        </DialogHeader>

        {capacityFailure && (
          <div className="rounded-md border border-border bg-muted/35 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.38c282a2c4',
              'The analyzer opens directly from here. You can also open it later from the lower-left toolbox menu by choosing Space Analyzer.'
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            {translate(
              'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.ae20d0ffc2',
              'Dismiss'
            )}
          </Button>
          {capacityFailure && (
            <Button type="button" size="sm" onClick={onOpenSpaceAnalyzer}>
              {translate(
                'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.6bee0c8f17',
                'Open Disk Space Analyzer'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

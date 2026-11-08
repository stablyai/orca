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
import { useTranslate } from '@/i18n/use-translate'
import { isTerminalSessionStorageCapacityFailure } from '../../../../../../shared/workspace-session/terminal-session-state-save-failure'

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
  const t = useTranslate()
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
              {t('terminal.sessionSaveFailure.title', 'Could not save terminal session')}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs leading-5">
            {capacityFailure
              ? t(
                  'terminal.sessionSaveFailure.capacity',
                  'The device saving this terminal reported full storage or an exceeded storage quota. Free space on that device, then try again.'
                )
              : t(
                  'terminal.sessionSaveFailure.unknown',
                  'Orca could not save the terminal state. Try again. If this continues, share the Orca logs with support so we can identify the cause.'
                )}
          </DialogDescription>
        </DialogHeader>

        {capacityFailure && (
          <div className="rounded-md border border-border bg-muted/35 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            {t(
              'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.38c282a2c4',
              'The analyzer opens directly from here. You can also open it later from the lower-left toolbox menu by choosing Space Analyzer.'
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            {t(
              'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.ae20d0ffc2',
              'Dismiss'
            )}
          </Button>
          {capacityFailure && (
            <Button type="button" size="sm" onClick={onOpenSpaceAnalyzer}>
              {t(
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

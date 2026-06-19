import { HardDrive } from 'lucide-react'
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

export function TerminalSessionStateSaveFailureDialog({
  open,
  onDismiss,
  onOpenSpaceAnalyzer
}: {
  open: boolean
  onDismiss: () => void
  onOpenSpaceAnalyzer: () => void
}): React.JSX.Element {
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
              <HardDrive className="size-4 text-muted-foreground" />
            </div>
            <DialogTitle className="text-base">
              {translate(
                'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.678c780a2c',
                'Disk space is unavailable'
              )}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs leading-5">
            {translate(
              'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.e2fcf07c0d',
              'Orca could not save this terminal session because local storage is full or not writable. Open the disk space analyzer to find workspace storage you can clean up.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-muted/35 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          {translate(
            'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.38c282a2c4',
            'The analyzer opens directly from here. You can also open it later from the lower-left toolbox menu by choosing Space Analyzer.'
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            {translate(
              'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.ae20d0ffc2',
              'Dismiss'
            )}
          </Button>
          <Button type="button" size="sm" autoFocus onClick={onOpenSpaceAnalyzer}>
            {translate(
              'auto.components.terminal.pane.TerminalSessionStateSaveFailureDialog.6bee0c8f17',
              'Open Disk Space Analyzer'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

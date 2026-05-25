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
            <DialogTitle className="text-base">Disk space is unavailable</DialogTitle>
          </div>
          <DialogDescription className="text-xs leading-5">
            Orca could not save this terminal session because local storage is full or not writable.
            Open the disk space analyzer to find workspace storage you can clean up.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-muted/35 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          The analyzer opens directly from here. You can also open it later from the lower-left
          toolbox menu by choosing Space Analyzer.
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button type="button" size="sm" autoFocus onClick={onOpenSpaceAnalyzer}>
            Open Disk Space Analyzer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

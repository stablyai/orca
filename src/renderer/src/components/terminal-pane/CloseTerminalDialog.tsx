import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type CloseTerminalDialogProps = {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Ghostty-style confirmation dialog shown when Cmd+W would kill a running
 * terminal process. The "Close" button is auto-focused so the user can
 * quickly confirm with Enter.
 */
export default function CloseTerminalDialog({
  open,
  onCancel,
  onConfirm
}: CloseTerminalDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onCancel()
        }
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">Close Terminal?</DialogTitle>
          <DialogDescription className="text-xs">
            The terminal still has a running process. If you close the terminal, the process will be
            killed.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" autoFocus onClick={onConfirm}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

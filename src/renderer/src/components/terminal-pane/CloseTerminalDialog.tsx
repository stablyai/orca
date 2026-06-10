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

export default function CloseTerminalDialog({
  open,
  onCancel,
  onConfirm
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
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
          <DialogTitle className="text-sm">{translate("auto.components.terminal.pane.CloseTerminalDialog.78b79d854d", "Close Terminal?")}</DialogTitle>
          <DialogDescription className="text-xs">
            {translate("auto.components.terminal.pane.CloseTerminalDialog.6b9a6975f8", "The terminal still has a running process. If you close the terminal, the process will be killed.")}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {translate("auto.components.terminal.pane.CloseTerminalDialog.1d1a7a9c1f", "Cancel")}</Button>
          <Button type="button" variant="destructive" size="sm" autoFocus onClick={onConfirm}>
            {translate("auto.components.terminal.pane.CloseTerminalDialog.ebd2fa844d", "Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

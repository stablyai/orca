import { Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { translate } from '@/i18n/i18n'

type SshDestructiveActionDialogProps = {
  open: boolean
  title: string
  description: string
  targetLabel?: string
  actionLabel: string
  busyLabel?: string
  isBusy?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}

export function SshDestructiveActionDialog({
  open,
  title,
  description,
  targetLabel,
  actionLabel,
  busyLabel,
  isBusy = false,
  onOpenChange,
  onConfirm
}: SshDestructiveActionDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isBusy && !nextOpen) {
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>

        {targetLabel ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all text-muted-foreground">{targetLabel}</div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            {translate("auto.components.settings.SshDestructiveActionDialog.895b216267", "Cancel")}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isBusy} className="gap-1.5">
            {isBusy ? <Loader2 className="size-3 animate-spin" /> : null}
            {isBusy ? (busyLabel ?? actionLabel) : actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

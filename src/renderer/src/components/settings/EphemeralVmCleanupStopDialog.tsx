import { Loader2 } from 'lucide-react'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

type EphemeralVmCleanupStopDialogProps = {
  runtime: EphemeralVmRuntimeRecord | null
  isStopping: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function EphemeralVmCleanupStopDialog({
  runtime,
  isStopping,
  onCancel,
  onConfirm
}: EphemeralVmCleanupStopDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={runtime !== null}
      onOpenChange={(open) => {
        if (!open && !isStopping) {
          onCancel()
        }
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={!isStopping}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.settings.EphemeralVmCleanupStopDialog.title',
              'Stop cleanup?'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.settings.EphemeralVmCleanupStopDialog.description',
              'The VM may remain running and incur charges. You can retry cleanup later.'
            )}
          </DialogDescription>
        </DialogHeader>
        {runtime ? (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            <div className="truncate">{runtime.workspaceName || runtime.recipeId}</div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isStopping}>
            {translate(
              'auto.components.settings.EphemeralVmCleanupStopDialog.cancel',
              'Keep cleaning'
            )}
          </Button>
          <Button onClick={onConfirm} disabled={isStopping}>
            {isStopping ? <Loader2 className="animate-spin" /> : null}
            {isStopping
              ? translate(
                  'auto.components.settings.EphemeralVmCleanupStopDialog.stopping',
                  'Stopping…'
                )
              : translate(
                  'auto.components.settings.EphemeralVmCleanupStopDialog.confirm',
                  'Stop cleanup'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

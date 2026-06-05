import { LoaderCircle } from 'lucide-react'
import type { PtyManagementSession } from '../../../../preload/api-types'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

type ManageSessionKillDialogProps = {
  session: PtyManagementSession | null
  isBusy: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ManageSessionKillDialog({
  session,
  isBusy,
  onCancel,
  onConfirm
}: ManageSessionKillDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (open) {
          return
        }
        // Why: destructive terminal mutations should keep their progress
        // dialog open until the daemon responds, matching other confirm flows.
        if (isBusy) {
          return
        }
        onCancel()
      }}
    >
      <DialogContent
        className="max-w-md"
        showCloseButton={!isBusy}
        onPointerDownOutside={(event) => {
          if (isBusy) {
            event.preventDefault()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (isBusy) {
            event.preventDefault()
          }
        }}
      >
        {session ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-sm">Kill this session?</DialogTitle>
              <DialogDescription className="text-xs">
                Force-quits <span className="font-medium text-foreground">{session.sessionId}</span>
                . Any unsaved work in that pane is lost. This can&apos;t be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel} disabled={isBusy}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={onConfirm} disabled={isBusy}>
                {isBusy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {isBusy ? 'Killing…' : 'Kill session'}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

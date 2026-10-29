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
import type { useResourcePtyActions } from './use-resource-pty-actions'

export function ResourcePtyEndDialog({
  actions
}: {
  actions: ReturnType<typeof useResourcePtyActions>
}) {
  const busy = !!actions.confirmation && actions.ending.has(actions.confirmation.identity)
  return (
    <Dialog
      open={actions.confirmation !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          actions.setConfirmation(null)
        }
      }}
    >
      <DialogContent
        className="z-[80]"
        overlayClassName="z-[80]"
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          const body = document.querySelector<HTMLDivElement>('[data-resource-pty-body]')
          if (body) {
            event.preventDefault()
            body.focus()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault()
          }
        }}
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('resourceManager.pty.endTitle', 'End {{terminal}}?', {
              terminal: actions.confirmation?.label ?? ''
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'resourceManager.pty.endDescription',
              'This ends the terminal and its child processes. Unsaved work may be lost.'
            )}
          </DialogDescription>
          {(actions.confirmation?.location || actions.confirmation?.foregroundProcess) && (
            <div className="space-y-1 rounded-md border border-border p-3 text-xs">
              {actions.confirmation.location && (
                <p className="break-all">{actions.confirmation.location}</p>
              )}
              {actions.confirmation.foregroundProcess && (
                <p className="text-muted-foreground">
                  {translate('resourceManager.pty.lastProcess', 'Last seen process: {{process}}', {
                    process: actions.confirmation.foregroundProcess
                  })}
                </p>
              )}
            </div>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => actions.setConfirmation(null)}>
            {translate('resourceManager.pty.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void actions.endConfirmed()}>
            {busy
              ? translate('resourceManager.pty.ending', 'Ending…')
              : translate('resourceManager.pty.end', 'End terminal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

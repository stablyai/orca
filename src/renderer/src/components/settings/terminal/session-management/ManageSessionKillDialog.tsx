import { LoaderCircle } from 'lucide-react'
import type { PtyManagementSession } from '../../../../../../preload/api/terminal/pty-management-api'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (open) {
          return
        }
        // Keep destructive-operation progress open until the daemon responds.
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
              <DialogTitle className="text-sm">
                {t(
                  'auto.components.settings.ManageSessionKillDialog.87dcafc85c',
                  'Kill this session?'
                )}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {t('auto.components.settings.ManageSessionKillDialog.8401328fed', 'Force-quits')}{' '}
                <span className="font-medium text-foreground">{session.sessionId}</span>
                {t(
                  'auto.components.settings.ManageSessionKillDialog.ad9832aa26',
                  ". Any unsaved work in that pane is lost. This can't be undone."
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel} disabled={isBusy}>
                {t('auto.components.settings.ManageSessionKillDialog.6bf4627168', 'Cancel')}
              </Button>
              <Button variant="destructive" onClick={onConfirm} disabled={isBusy}>
                {isBusy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {isBusy
                  ? t('auto.components.settings.ManageSessionKillDialog.d3dba51b15', 'Killing…')
                  : t(
                      'auto.components.settings.ManageSessionKillDialog.0b0db4c68c',
                      'Kill session'
                    )}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

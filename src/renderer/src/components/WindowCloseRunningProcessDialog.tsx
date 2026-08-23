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
import { useWindowCloseRunningProcessConfirmStore } from './window-close-request-coordinator'

export default function WindowCloseRunningProcessDialog(): React.JSX.Element {
  const open = useWindowCloseRunningProcessConfirmStore(
    (state) => state.windowCloseRunningProcessConfirm !== null
  )
  const confirm = useWindowCloseRunningProcessConfirmStore(
    (state) => state.confirmWindowCloseRunningProcessConfirm
  )
  const cancel = useWindowCloseRunningProcessConfirmStore(
    (state) => state.cancelWindowCloseRunningProcessConfirm
  )

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && cancel()}>
      <DialogContent
        className="max-w-sm"
        data-testid="window-close-running-process-dialog"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.Terminal.2fa9c69ff3', 'Close Window?')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.Terminal.7958465754',
              'There are local terminals with running processes. Close the window anyway?'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={cancel}>
            {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            autoFocus
            data-testid="window-close-running-process-confirm"
            onClick={confirm}
          >
            {translate('auto.components.Terminal.73768427cf', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

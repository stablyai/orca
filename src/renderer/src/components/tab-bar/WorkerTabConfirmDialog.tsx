import { useSyncExternalStore } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import { closeWorkerTab, stopWorker } from './worker-tab-explicit-actions'
import {
  currentWorkerTabConfirm,
  publishWorkerTabConfirm,
  subscribeWorkerTabConfirm,
  type WorkerTabConfirmKind
} from './worker-tab-confirm-request'

function copy(kind: WorkerTabConfirmKind): { title: string; confirm: string } {
  switch (kind) {
    case 'stop':
      return {
        title: translate('workerTabs.confirm.stopTitle', 'Stop this worker? Its task ends.'),
        confirm: translate('workerTabs.confirm.stop', 'Stop')
      }
    case 'close-running':
      return {
        title: translate(
          'workerTabs.confirm.closeRunningTitle',
          'Stop this worker and close its tab?'
        ),
        confirm: translate('workerTabs.confirm.stopAndClose', 'Stop and close')
      }
    case 'close-finished':
      return {
        title: translate(
          'workerTabs.confirm.closeFinishedTitle',
          "Close this worker's tab? Anything still running in it stops."
        ),
        confirm: translate('workerTabs.confirm.close', 'Close')
      }
  }
}

export default function WorkerTabConfirmDialog(): React.JSX.Element {
  const t = useTranslate()
  const request = useSyncExternalStore(subscribeWorkerTabConfirm, currentWorkerTabConfirm)
  const text = request ? copy(request.kind) : null
  const confirm = (): void => {
    if (!request) {
      return
    }
    publishWorkerTabConfirm(null)
    if (request.kind === 'stop') {
      void stopWorker(request.worktreeId, request.tab)
    } else {
      void closeWorkerTab(request.worktreeId, request.tab)
    }
  }
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(isOpen) => !isOpen && publishWorkerTabConfirm(null)}
    >
      <DialogContent
        surface="security"
        className="max-w-sm"
        showCloseButton={false}
        initialFocus="cancel"
      >
        <DialogHeader>
          <DialogTitle>{text?.title}</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-dialog-cancel=""
            onClick={() => publishWorkerTabConfirm(null)}
          >
            {t('workerTabs.confirm.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={confirm}>
            {text?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

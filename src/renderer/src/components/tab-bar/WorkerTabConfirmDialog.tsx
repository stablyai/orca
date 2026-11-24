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
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { closeWorkerTab, stopWorker, explainWorkerTabHomeStop } from './worker-tab-explicit-actions'
import { isWorkerTabKnownFinished, workerTabStopRequiresHome } from './worker-tab-run-state'
import { useAppStore } from '@/store/index'

/** stop: Stop worker; close-running: Close while it may still run; close-finished: Close on a finished row. */
export type WorkerTabConfirmKind = 'stop' | 'close-running' | 'close-finished'

type WorkerTabConfirmRequest = { kind: WorkerTabConfirmKind; worktreeId: string; tab: Tab }

let current: WorkerTabConfirmRequest | null = null
const listeners = new Set<() => void>()

function publish(next: WorkerTabConfirmRequest | null): void {
  current = next
  for (const listener of listeners) {
    listener()
  }
}

/** Ask once, then run the explicit action; Cancel changes nothing. */
export function requestWorkerTabConfirm(request: WorkerTabConfirmRequest): void {
  if (
    workerTabStopRequiresHome(request.tab) &&
    (request.kind !== 'close-finished' ||
      !isWorkerTabKnownFinished(useAppStore.getState(), request.tab))
  ) {
    explainWorkerTabHomeStop()
    return
  }
  publish(request)
}

/** Close tab / Close: the finished-row copy only when the worker is known finished. */
export function requestWorkerTabClose(worktreeId: string, tab: Tab, finishedRow = false): void {
  if (workerTabStopRequiresHome(tab)) {
    requestWorkerTabConfirm({
      kind: isWorkerTabKnownFinished(useAppStore.getState(), tab)
        ? 'close-finished'
        : 'close-running',
      worktreeId,
      tab
    })
    return
  }
  const finished = finishedRow || isWorkerTabKnownFinished(useAppStore.getState(), tab)
  requestWorkerTabConfirm({ kind: finished ? 'close-finished' : 'close-running', worktreeId, tab })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

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
  const request = useSyncExternalStore(subscribe, () => current)
  const text = request ? copy(request.kind) : null
  const confirm = (): void => {
    if (!request) {
      return
    }
    publish(null)
    if (request.kind === 'stop') {
      void stopWorker(request.worktreeId, request.tab)
    } else {
      void closeWorkerTab(request.worktreeId, request.tab)
    }
  }
  return (
    <Dialog open={request !== null} onOpenChange={(isOpen) => !isOpen && publish(null)}>
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
            onClick={() => publish(null)}
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

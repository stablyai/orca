import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { isWorkerTabKnownFinished, workerTabStopRequiresHome } from './worker-tab-run-state'
import { useAppStore } from '@/store/index'

// The confirm request lives apart from the dialog so close paths can ask without importing the actions it runs.

export function explainWorkerTabHomeStop(): void {
  toast.error(
    translate(
      'workerTabs.remote.stopFromHome',
      "Can't stop this worker here · stop it on the computer that started it"
    )
  )
}

/** stop: Stop worker; close-running: Close while it may still run; close-finished: Close on a finished row. */
export type WorkerTabConfirmKind = 'stop' | 'close-running' | 'close-finished'

export type WorkerTabConfirmRequest = { kind: WorkerTabConfirmKind; worktreeId: string; tab: Tab }

let current: WorkerTabConfirmRequest | null = null
const listeners = new Set<() => void>()

export function publishWorkerTabConfirm(next: WorkerTabConfirmRequest | null): void {
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
  publishWorkerTabConfirm(request)
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

export function subscribeWorkerTabConfirm(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function currentWorkerTabConfirm(): WorkerTabConfirmRequest | null {
  return current
}

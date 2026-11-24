import { prepareWorkerStopLanding } from './worker-stop-landing'
import { explainWorkerTabHomeStop } from './worker-tab-confirm-request'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { currentWorkerLineage } from '../../../../shared/orchestration/workers/worker-tab-stamp'
import { closeTerminalTab } from '../terminal/tab-lifecycle/terminal-tab-actions'
import {
  isWorkerTabKnownFinished,
  workerTabContext,
  workerTabStopRequiresHome
} from './worker-tab-run-state'

import type { WorkerStopReceipt } from '../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'

export type WorkerStopOutcome = 'stopped' | 'not-confirmed' | 'refused'

function targetFor(worktreeId: string): RuntimeClientTarget {
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
  return environmentId !== null ? { kind: 'environment', environmentId } : { kind: 'local' }
}

/** The worker's own Dispatch: the live context's when it names this pane, else the stamp's latest. */
function dispatchIdOf(tab: Tab): string | null {
  return (
    workerTabContext(useAppStore.getState(), tab)?.dispatchId ??
    (tab.workerTab ? currentWorkerLineage(tab.workerTab).dispatchId : undefined) ??
    null
  )
}

function receiptOutcome(receipt: WorkerStopReceipt | null): WorkerStopOutcome {
  if (!receipt) {
    return 'refused'
  }
  if (
    receipt.processAction === 'unknown' ||
    (receipt.warning && receipt.processAction === 'none')
  ) {
    return 'not-confirmed'
  }
  if (receipt.alreadySettled || receipt.state === 'stopped') {
    return 'stopped'
  }
  return 'not-confirmed'
}

/** Stop through the host's fence, exactly as `orca orchestration worker-stop`; helpers stop too. */
export async function stopWorker(worktreeId: string, tab: Tab): Promise<WorkerStopOutcome> {
  if (workerTabStopRequiresHome(tab)) {
    explainWorkerTabHomeStop()
    return 'refused'
  }
  const dispatch = dispatchIdOf(tab)
  if (!dispatch) {
    toast.error(translate('workerTabs.stop.refused', "Couldn't stop this worker"))
    return 'refused'
  }
  const landWhenStopped = prepareWorkerStopLanding(worktreeId, tab.id)
  const receipt = await callRuntimeRpc<WorkerStopReceipt>(
    targetFor(worktreeId),
    'orchestration.workerStop',
    { dispatch },
    { suppressFeatureInteraction: true }
  ).catch(() => null)
  const outcome = receiptOutcome(receipt)
  if (outcome === 'stopped') {
    landWhenStopped(!receipt?.alreadySettled)
  }
  if (outcome === 'refused') {
    toast.error(translate('workerTabs.stop.refused', "Couldn't stop this worker"))
  } else if (outcome === 'not-confirmed') {
    toast.error(translate('workerTabs.stop.notConfirmed', "Couldn't confirm the worker stopped"))
  }
  const helperFailed =
    Boolean(receipt?.helperStopError) ||
    (receipt?.helpers ?? []).some(
      (helper) => helper.outcome !== 'stopped' && helper.outcome !== 'already_finished'
    )
  if (helperFailed) {
    toast.warning(translate('workerTabs.stop.helpers', "Some helpers didn't stop"))
  }
  return outcome
}

function closeTabNow(tab: Tab): void {
  if (tab.contentType === 'terminal') {
    closeTerminalTab(tab.entityId, {
      reason: 'user',
      endsWorker: true,
      skipRunningProcessConfirm: true
    })
    return
  }
  useAppStore.getState().closeUnifiedTab(tab.id)
}

/** Close tab / Close: a worker not known finished is stopped through the fence first; any unconfirmed stop keeps the tab. */
export async function closeWorkerTab(worktreeId: string, tab: Tab): Promise<void> {
  if (workerTabStopRequiresHome(tab)) {
    if (isWorkerTabKnownFinished(useAppStore.getState(), tab)) {
      closeTabNow(tab)
    } else {
      explainWorkerTabHomeStop()
    }
    return
  }
  if (isWorkerTabKnownFinished(useAppStore.getState(), tab)) {
    closeTabNow(tab)
    return
  }
  if ((await stopWorker(worktreeId, tab)) !== 'stopped') {
    return
  }
  const latest = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tab.id
  )
  // The host's stop may already have closed the worker's terminal and with it the tab.
  if (latest) {
    closeTabNow(latest)
  }
}

import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { translate } from '@/i18n/i18n'
import { isWorkerTabKnownRunning } from './worker-tab-run-state'
import {
  hideWorkerTabInStore,
  keepWorkerTabInState,
  type WorkerTabHideResult
} from './worker-tab-view-actions'
export { isHideableWorkerTab, isMixedWorkerTabInLayout } from './worker-tab-view-actions'

export function notifyWorkerTabHidden({
  state,
  tab,
  worktreeId,
  reachable
}: WorkerTabHideResult): void {
  const show = (): void => {
    useAppStore.getState().activateTab(tab.id, { worktreeId })
  }
  const action = { label: translate('workerTabs.hideToast.show', 'Show'), onClick: show }
  if (!reachable) {
    toast(translate('workerTabs.hideToast.unreachable', 'Hidden · find it in tab search'), {
      action
    })
    return
  }
  if (useAppStore.getState().workerTabHideHintShown || !isWorkerTabKnownRunning(state, tab)) {
    return
  }
  state.markWorkerTabHideHintShown()
  toast(translate('workerTabs.hideToast.running', 'Still running · open it from the sidebar'), {
    action
  })
}

export function hideWorkerTab(id: string, options?: { notify?: boolean }): boolean {
  const hidden = hideWorkerTabInStore(useAppStore.getState, id)
  if (!hidden) {
    return false
  }
  if (options?.notify !== false) {
    notifyWorkerTabHidden(hidden)
  }
  return true
}

export function keepWorkerTab(worktreeId: string, tab: Pick<Tab, 'id' | 'groupId'>): void {
  keepWorkerTabInState(useAppStore.getState(), worktreeId, tab)
}

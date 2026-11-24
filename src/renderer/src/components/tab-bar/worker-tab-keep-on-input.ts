import { useAppStore } from '@/store/index'
import { indexedWorkerTab } from './worker-tab-index'
import { workerTabContext } from './worker-tab-run-state'
import { keepWorkerTab } from './worker-tab-hide'
import { keepPlacedWorkerTabInState } from './worker-tab-view-actions'

// Ctrl+C, Esc, Ctrl+D, Ctrl+Z: stopping or backing out of a worker is not adopting its tab.
const INTERRUPT_INPUTS = new Set(['\x03', '\x1b', '\x04', '\x1a'])

/** The user's own typing keeps a worker's tab, except interrupts and answers to a worker that needs them. */
export function keepWorkerTabOnUserInput(
  worktreeId: string,
  terminalTabId: string,
  data: string
): void {
  if (INTERRUPT_INPUTS.has(data)) {
    return
  }
  const state = useAppStore.getState()
  // Indexed per tab array, so typing in a workspace without workers costs no scan.
  const tab = indexedWorkerTab(state.unifiedTabsByWorktree[worktreeId], terminalTabId)
  if (
    tab?.contentType !== 'terminal' ||
    tab.entityId !== terminalTabId ||
    state.workerTabStripChoiceByWorktree[worktreeId]?.[tab.id] === 'kept'
  ) {
    return
  }
  // Answering a prompt (1, y, Enter) while the worker needs you leaves it a worker.
  if (workerTabContext(state, tab)?.attention?.requiresAction) {
    return
  }
  keepWorkerTab(worktreeId, tab)
}

/** Dragging, splitting or pinning adopts a worker tab in this window. */
export function keepPlacedWorkerTab(worktreeId: string, tabIdOrEntityId: string): void {
  keepPlacedWorkerTabInState(useAppStore.getState(), worktreeId, tabIdOrEntityId)
}

export function keepWorkerSurfaceOnUserSend(entityId: string): void {
  const state = useAppStore.getState()
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const tab = tabs.find((tab) => tab.entityId === entityId)
    if (tab?.workerTab && !workerTabContext(state, tab)?.attention?.requiresAction) {
      keepWorkerTab(worktreeId, tab)
      return
    }
  }
}

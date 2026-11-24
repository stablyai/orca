import { useAppStore } from '@/store/index'
import type { WorkerTabsMode } from '../../../../shared/workspace-layout/tab-groups/worker-tab-visibility'

/** Switching back to Open when clicked never folds the tab a pane is showing: it becomes that pane's peek. */
export function applyWorkerTabsMode(mode: WorkerTabsMode): void {
  const state = useAppStore.getState()
  if (mode === 'open-when-clicked' && state.workerTabsMode !== mode) {
    for (const [worktreeId, groups] of Object.entries(state.groupsByWorktree)) {
      const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
      for (const group of groups) {
        const active = tabs.find((tab) => tab.id === group.activeTabId)
        if (
          active?.workerTab &&
          state.workerTabStripChoiceByWorktree[worktreeId]?.[active.id] !== 'kept'
        ) {
          state.peekWorkerTab(group.id, active.id)
        }
      }
    }
  }
  state.setWorkerTabsMode(mode)
}

import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import { saveWorkerTabWindowChoices } from '@/components/tab-bar/worker-tab-window-choices'

/** Keep view choices only while their tab remains in this workspace. */
export function pruneWorkerTabViewsOnTabRemoval(api: StoreApi<AppState>): void {
  api.subscribe((state, previous) => {
    if (
      !state.workspaceSessionReady ||
      state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree
    ) {
      return
    }
    let choices = state.workerTabStripChoiceByWorktree
    const removed = new Set<string>()
    for (const worktreeId in previous.unifiedTabsByWorktree) {
      const before = previous.unifiedTabsByWorktree[worktreeId]!
      const after = state.unifiedTabsByWorktree[worktreeId]
      if (before === after) {
        continue
      }
      const ids = new Set(after?.map((tab) => tab.id))
      for (const tab of before) {
        if (!ids.has(tab.id)) {
          removed.add(tab.id)
        }
      }
      const oldChoices = choices[worktreeId]
      if (!oldChoices) {
        continue
      }
      const retained = Object.entries(oldChoices).filter(([id]) => ids.has(id))
      if (retained.length === Object.keys(oldChoices).length) {
        continue
      }
      if (choices === state.workerTabStripChoiceByWorktree) {
        choices = { ...choices }
      }
      if (retained.length) {
        choices[worktreeId] = Object.fromEntries(retained)
      } else {
        delete choices[worktreeId]
      }
    }
    if (choices !== state.workerTabStripChoiceByWorktree || removed.size) {
      api.setState({
        workerTabStripChoiceByWorktree: choices,
        workerTabFailOpenShown: Object.fromEntries(
          Object.entries(state.workerTabFailOpenShown).filter(([id]) => !removed.has(id))
        ),
        workerTabPeekByGroupId: Object.fromEntries(
          Object.entries(state.workerTabPeekByGroupId).filter(([, id]) => !removed.has(id))
        )
      })
      if (choices !== state.workerTabStripChoiceByWorktree) {
        saveWorkerTabWindowChoices(choices)
      }
    }
  })
}

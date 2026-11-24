import { windowGroupSelectionPatch } from '@/store/workspace-layout/workspace-layout-cache'
import type { AppState } from '@/store/types'
import { selectFoldedWorkerTabIds } from './worker-tab-folding'
import { workerTabContext } from './worker-tab-run-state'

export function workerWorkspacePeekPatch(state: AppState, worktreeId: string): Partial<AppState> {
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const groups = state.groupsByWorktree[worktreeId] ?? []
  let selectionPatch: Partial<AppState> = {}
  let changed = false
  let peek = state.workerTabPeekByGroupId
  for (const group of groups) {
    if (group.activeTabId) {
      continue
    }
    const folded = selectFoldedWorkerTabIds(state, worktreeId, group.id)
    if (!folded.size || group.tabOrder.some((id) => !folded.has(id))) {
      continue
    }
    const candidates = tabs
      .filter((tab) => folded.has(tab.id))
      .sort(
        (a, b) =>
          Number(Boolean(workerTabContext(state, b)?.attention?.requiresAction)) -
            Number(Boolean(workerTabContext(state, a)?.attention?.requiresAction)) ||
          (b.lastFocusedAt ?? b.createdAt) - (a.lastFocusedAt ?? a.createdAt)
      )
    const tab = candidates[0]
    if (!tab) {
      continue
    }
    selectionPatch = windowGroupSelectionPatch(
      { ...state, ...selectionPatch },
      worktreeId,
      group.id,
      tab.id
    )
    changed = true
    peek = { ...peek, [group.id]: tab.id }
  }
  return changed ? { ...selectionPatch, workerTabPeekByGroupId: peek } : {}
}

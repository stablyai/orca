import { useAppStore } from '../../store'
import type { TabDragActivationSnapshot } from '../../store/slices/tabs/tabs-slice-contract'

export function captureTabDragActivationSnapshot(worktreeId: string): TabDragActivationSnapshot {
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  return {
    activeGroupId: state.activeGroupIdByWorktree[worktreeId] ?? null,
    activeTabIdByGroup: Object.fromEntries(groups.map((group) => [group.id, group.activeTabId]))
  }
}

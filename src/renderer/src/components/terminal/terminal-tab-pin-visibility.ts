import { useAppStore } from '@/store'

export function isPinnedVisibleTerminalTab(worktreeId: string, visibleId: string): boolean {
  return (
    (useAppStore.getState().unifiedTabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => (tab.id === visibleId || tab.entityId === visibleId) && tab.isPinned
    ) ?? false
  )
}

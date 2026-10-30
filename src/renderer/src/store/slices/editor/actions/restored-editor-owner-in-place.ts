import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { AppState } from '../../../types'

type InPlaceTabState = Pick<
  AppState,
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'tabBarOrderByWorktree'
  | 'unifiedTabsByWorktree'
>

/** Reown inside a workspace by ID change only, preserving group/order/focus; cross-workspace moves append as new tabs. */
export function rekeyRestoredEditorTabsInPlace(
  s: InPlaceTabState,
  worktreeId: string,
  fileIdMigrations: ReadonlyMap<string, string>,
  tabIdMigrations: ReadonlyMap<string, string>,
  executionHostId: ExecutionHostId
): InPlaceTabState {
  const tabId = (id: string): string => tabIdMigrations.get(id) ?? id
  const fileId = (id: string): string => fileIdMigrations.get(id) ?? id
  const activeFileId = s.activeFileIdByWorktree[worktreeId]
  return {
    activeFileIdByWorktree: {
      ...s.activeFileIdByWorktree,
      [worktreeId]: activeFileId ? fileId(activeFileId) : activeFileId
    },
    activeGroupIdByWorktree: s.activeGroupIdByWorktree,
    activeTabTypeByWorktree: s.activeTabTypeByWorktree,
    layoutByWorktree: s.layoutByWorktree,
    groupsByWorktree: {
      ...s.groupsByWorktree,
      [worktreeId]: (s.groupsByWorktree[worktreeId] ?? []).map((group) => ({
        ...group,
        activeTabId: group.activeTabId ? tabId(group.activeTabId) : group.activeTabId,
        tabOrder: group.tabOrder.map(tabId),
        ...(group.recentTabIds ? { recentTabIds: group.recentTabIds.map(tabId) } : {})
      }))
    },
    unifiedTabsByWorktree: {
      ...s.unifiedTabsByWorktree,
      [worktreeId]: (s.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) =>
        tabIdMigrations.has(tab.id) || fileIdMigrations.has(tab.entityId)
          ? {
              ...tab,
              id: tabId(tab.id),
              entityId: fileId(tab.entityId),
              ...(tab.executionHostId ? { executionHostId } : {})
            }
          : tab
      )
    },
    tabBarOrderByWorktree: {
      ...s.tabBarOrderByWorktree,
      [worktreeId]: (s.tabBarOrderByWorktree[worktreeId] ?? []).map(fileId)
    }
  }
}

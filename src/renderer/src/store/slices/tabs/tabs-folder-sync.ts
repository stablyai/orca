import type { TabFolderGroup } from '../../../../../shared/tab-folder-types'
import { syncFolderTabOrdersFromGroupOrder } from '../../../../../shared/tab-folder-group-state'
import type { AppState } from '../../types'

export function syncWorktreeFolderTabOrders(
  tabFolderGroupsByWorktree: Record<string, TabFolderGroup[]> | undefined,
  worktreeId: string,
  splitGroupId: string,
  tabOrder: readonly string[]
): Pick<AppState, 'tabFolderGroupsByWorktree'> {
  return {
    tabFolderGroupsByWorktree: {
      ...tabFolderGroupsByWorktree,
      [worktreeId]: syncFolderTabOrdersFromGroupOrder(
        tabFolderGroupsByWorktree?.[worktreeId] ?? [],
        tabOrder,
        splitGroupId
      )
    }
  }
}

export function expandFolderGroupIfCollapsed(
  tabFolderGroupsByWorktree: Record<string, TabFolderGroup[]> | undefined,
  worktreeId: string,
  folderGroupId: string
): Pick<AppState, 'tabFolderGroupsByWorktree'> | Record<string, never> {
  const folders = tabFolderGroupsByWorktree?.[worktreeId]
  const folder = folders?.find((candidate) => candidate.id === folderGroupId)
  if (!folder?.collapsed || !folders) {
    return {}
  }
  return {
    tabFolderGroupsByWorktree: {
      ...tabFolderGroupsByWorktree,
      [worktreeId]: folders.map((candidate) =>
        candidate.id === folderGroupId ? { ...candidate, collapsed: false } : candidate
      )
    }
  }
}

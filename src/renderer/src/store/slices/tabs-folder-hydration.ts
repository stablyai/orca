import type { Tab } from '../../../../shared/tab-types'
import type { TabFolderGroup } from '../../../../shared/tab-folder-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { applyFolderMembershipAfterTabChange } from '../../../../shared/tab-folder-group-state'

export function hydrateTabFolderGroups(
  session: WorkspaceSessionState,
  tabsByWorktree: Record<string, Tab[]>,
  validWorktreeIds: Set<string>
): Record<string, TabFolderGroup[]> {
  const folderGroupsByWorktree: Record<string, TabFolderGroup[]> = {}
  for (const [worktreeId, folders] of Object.entries(session.tabFolderGroups ?? {})) {
    if (!validWorktreeIds.has(worktreeId) || folders.length === 0) {
      continue
    }
    const { tabs, folders: sanitized } = applyFolderMembershipAfterTabChange(
      tabsByWorktree[worktreeId] ?? [],
      folders
    )
    tabsByWorktree[worktreeId] = tabs
    if (sanitized.length > 0) {
      folderGroupsByWorktree[worktreeId] = sanitized
    }
  }
  return folderGroupsByWorktree
}

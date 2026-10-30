import type { ExecutionHostId } from '../execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../worktree/host-qualified-identity'
import type { Worktree } from '../worktree/types'
import { folderWorkspaceToWorktree } from '../folder-workspace-worktree'
import type { HostSectionRow } from './host-section-rows'

/** The desktop's open workspace, as its session saves it; both null when nothing is open. */
export type ActiveSidebarWorkspace = {
  worktreeId: string | null
  hostId: ExecutionHostId | null
}

/** Every occurrence of the open workspace highlights, so a pinned duplicate shows twice. */
export function isActiveSidebarWorkspace(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  active: ActiveSidebarWorkspace
): boolean {
  return (
    active.worktreeId === worktree.id &&
    (!active.hostId ||
      getWorktreeHostIdentity(worktree) === composeWorktreeHostIdentity(active.hostId, worktree.id))
  )
}

/** Row keys of every occurrence of `active`; a pinned duplicate shows twice. */
export function collectActiveRowKeys(
  sectionRows: readonly HostSectionRow[],
  active: ActiveSidebarWorkspace
): Set<string> {
  const activeRowKeys = new Set<string>()
  for (const row of sectionRows) {
    if (row.type === 'item' && isActiveSidebarWorkspace(row.worktree, active)) {
      activeRowKeys.add(row.rowKey)
    } else if (
      row.type === 'folder-workspace' &&
      isActiveSidebarWorkspace(folderWorkspaceToWorktree(row.folderWorkspace), active)
    ) {
      activeRowKeys.add(row.key)
    }
  }
  return activeRowKeys
}

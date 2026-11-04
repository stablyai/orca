import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { getFolderWorkspaceWorktreeHostId } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'

type PickableWorktree = {
  id: string
  hostId?: string
  isArchived?: boolean
  lastActivityAt?: number
}

/** A workspace to show a plugin beside when none is: this machine's most recently active
 *  worktree, else its first folder workspace. */
export function pickWorkspaceToShow(
  worktreesByRepo: Readonly<Record<string, readonly PickableWorktree[]>> | undefined,
  folderWorkspaces:
    | readonly Pick<FolderWorkspace, 'id' | 'executionHostId' | 'connectionId' | 'isArchived'>[]
    | undefined
): string | null {
  const isLocal = (hostId: string | undefined): boolean =>
    hostId === undefined || hostId === LOCAL_EXECUTION_HOST_ID
  const worktree = Object.values(worktreesByRepo ?? {})
    .flat()
    .filter((each) => !each.isArchived && isLocal(each.hostId))
    .reduce<PickableWorktree | null>(
      (best, each) =>
        !best || (each.lastActivityAt ?? 0) > (best.lastActivityAt ?? 0) ? each : best,
      null
    )
  if (worktree) {
    return worktree.id
  }
  const folder = (folderWorkspaces ?? []).find(
    (each) => !each.isArchived && isLocal(getFolderWorkspaceWorktreeHostId(each))
  )
  return folder ? folderWorkspaceKey(folder.id) : null
}

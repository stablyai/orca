import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { findKnownWorktreeById } from '../worktrees/listing/detected-worktree-meta'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import '../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../../shared/folder-workspaces/folder-workspace-host-id'
import type { AppState } from '../../types'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'

// Read-only lookups of the persisted workspace flag and the row it lives on.

/** Same-id folder rows: the on-screen host's, else the first. */
export function folderRowToMark(
  state: AppState,
  worktreeId: string,
  folderWorkspaceId: string
): FolderWorkspace | undefined {
  return folderRowOnHost(state, folderWorkspaceId, onScreenHostId(state, worktreeId))
}

/** The folder row on `host`, or the first same-id row when no host is named. */
export function folderRowOnHost(
  state: AppState,
  folderWorkspaceId: string,
  host: ExecutionHostId | null
): FolderWorkspace | undefined {
  return selectFolderWorkspaces(state).find(
    (workspace) =>
      workspace.id === folderWorkspaceId &&
      (!host || getFolderWorkspaceHostId(workspace, state.projectGroups) === host)
  )
}

/** The host whose row is on screen: the active workspace's, else null (every same-id row). */
export function onScreenHostId(
  state: Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>,
  worktreeId: string
): ExecutionHostId | null {
  return worktreeId === state.activeWorktreeId ? state.activeWorkspaceExecutionHostId : null
}

/** The flag {@link clearWorkspaceUnreadFlag} would clear. */
export function isWorkspaceFlagSet(
  state: Parameters<typeof findKnownWorktreeById>[0] & Pick<AppState, 'projectGroups'>,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): boolean {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return selectFolderWorkspaces(state).some(
      (workspace) =>
        workspace.id === workspaceScope.folderWorkspaceId &&
        Boolean(workspace.isUnread) &&
        (!executionHostId ||
          getFolderWorkspaceHostId(workspace, state.projectGroups) === executionHostId)
    )
  }
  return Boolean(findKnownWorktreeById(state, worktreeId, executionHostId ?? undefined)?.isUnread)
}

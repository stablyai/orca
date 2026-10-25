import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import type { AppState } from './types'
import {
  folderWorkspaceMatchesHost,
  getFolderWorkspaceWorktree
} from './slices/worktrees/listing/detected-worktree-meta'

// Route workspace readers here; check-workspace-record-read-ratchet.mjs enforces this boundary.

export type WorkspaceRecordState = Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>

/** Git worktrees per repo id, in listing order. */
export function selectWorktreesByRepo(
  state: Pick<AppState, 'worktreesByRepo'>
): AppState['worktreesByRepo'] {
  return state.worktreesByRepo
}

export function selectFolderWorkspaces(
  state: Pick<AppState, 'folderWorkspaces'>
): AppState['folderWorkspaces'] {
  return state.folderWorkspaces
}

/** Checkouts git reports that Orca does not track, per repo id. */
export function selectDetectedWorktreesByRepo(
  state: Pick<AppState, 'detectedWorktreesByRepo'>
): AppState['detectedWorktreesByRepo'] {
  return state.detectedWorktreesByRepo
}

function findFolderWorkspaceForTarget(
  folderWorkspaces: readonly FolderWorkspace[],
  folderWorkspaceId: string,
  hostId: ExecutionHostId
): FolderWorkspace | undefined {
  return folderWorkspaces.find(
    (workspace) =>
      workspace.id === folderWorkspaceId && folderWorkspaceMatchesHost(workspace, hostId)
  )
}

/**
 * The row that owns `target` on its host, including a paired runtime's logical host alias.
 * An ambiguous owner on that host answers undefined.
 */
export function selectWorkspaceByHostTarget(
  state: WorkspaceRecordState,
  target: HostWorktreeTarget
): Worktree | undefined {
  const scope = parseWorkspaceKey(target.id)
  if (scope?.type === 'folder') {
    const folder = findFolderWorkspaceForTarget(
      state.folderWorkspaces,
      scope.folderWorkspaceId,
      target.hostId
    )
    return folder ? getFolderWorkspaceWorktree(folder) : undefined
  }
  return (
    findIndexedWorktreeOwnerForHost(state.worktreesByRepo, target.id, target.hostId) ?? undefined
  )
}

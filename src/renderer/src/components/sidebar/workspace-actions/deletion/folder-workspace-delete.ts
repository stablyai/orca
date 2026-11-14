import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { blockRemovalForUnsavedFiles } from './removal-unsaved-files'
import { getExecutionHostIdForFolderWorkspace } from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import '../../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspaces/folder-workspace-host-id'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

const pendingFolderDeletes = new Map<string, Promise<boolean>>()

/** Mirrors deleteFolderWorkspace: its tabs close only when no same-id folder survives elsewhere. */
export function folderWorkspaceDeleteClosesTabs(
  state: AppState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): boolean {
  const ownerHostId = getExecutionHostIdForFolderWorkspace(
    state,
    folderWorkspaceId,
    executionHostId
  )
  return !selectFolderWorkspaces(state).some(
    (workspace) =>
      workspace.id === folderWorkspaceId &&
      getFolderWorkspaceHostId(workspace, state.projectGroups) !== ownerHostId
  )
}

/** Refuse folder deletion that would discard unsaved editor text; return null when refused. */
export function deleteFolderWorkspaceUnlessUnsaved(
  getState: () => AppState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId,
  options?: { allowFailedArchiveHook?: boolean }
): Promise<boolean> | null {
  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  const pendingIdentity = composeWorktreeHostIdentity(
    getExecutionHostIdForFolderWorkspace(getState(), folderWorkspaceId, executionHostId),
    workspaceKey
  )
  const pending = pendingFolderDeletes.get(pendingIdentity)
  if (pending) {
    return pending
  }
  const name =
    selectFolderWorkspaces(getState()).find((workspace) => workspace.id === folderWorkspaceId)
      ?.name ?? folderWorkspaceId
  // Why block, not confirm: the files stay on disk, so the user saves or closes them first.
  if (
    folderWorkspaceDeleteClosesTabs(getState(), folderWorkspaceId, executionHostId) &&
    blockRemovalForUnsavedFiles(getState, [{ id: workspaceKey, hostId: executionHostId }], name)
  ) {
    return null
  }
  const deletion = getState()
    .deleteFolderWorkspace(
      folderWorkspaceId,
      executionHostId || options?.allowFailedArchiveHook
        ? {
            ...(executionHostId ? { executionHostId } : {}),
            ...(options?.allowFailedArchiveHook ? { allowFailedArchiveHook: true } : {})
          }
        : undefined
    )
    .then((deleted) => {
      const current = getState()
      if (
        deleted &&
        current.activeWorktreeId === workspaceKey &&
        (!executionHostId || current.activeWorkspaceExecutionHostId === executionHostId)
      ) {
        current.setActiveWorktree(null)
      }
      return deleted
    })
    .finally(() => pendingFolderDeletes.delete(pendingIdentity))
  pendingFolderDeletes.set(pendingIdentity, deletion)
  return deletion
}

import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import type { FolderWorkspaceDeleteOptions } from '@/store/repos/repo-state'
import { blockRemovalForUnsavedFiles } from './removal-unsaved-files'
import { getExecutionHostIdForFolderWorkspace } from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

const pendingFolderDeletes = new Map<string, Promise<boolean>>()

/** Refuse folder deletion that would discard unsaved editor text; return null when refused. */
export function deleteFolderWorkspaceUnlessUnsaved(
  getState: () => AppState,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId,
  options?: Pick<FolderWorkspaceDeleteOptions, 'remove' | 'allowFailedArchiveHook'>
): Promise<boolean> | null {
  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  const ownerHostId = getExecutionHostIdForFolderWorkspace(
    getState(),
    folderWorkspaceId,
    executionHostId
  )
  const pendingIdentity = composeWorktreeHostIdentity(ownerHostId, workspaceKey)
  const pending = pendingFolderDeletes.get(pendingIdentity)
  if (pending) {
    return pending
  }
  const name =
    selectFolderWorkspaces(getState()).find((workspace) => workspace.id === folderWorkspaceId)
      ?.name ?? folderWorkspaceId
  // Why block, not confirm: the files stay on disk, so the user saves or closes them first.
  if (blockRemovalForUnsavedFiles(getState, [{ id: workspaceKey, hostId: ownerHostId }], name)) {
    return null
  }
  const deletion = getState()
    .deleteFolderWorkspace(folderWorkspaceId, {
      executionHostId,
      ...(options?.remove ? { remove: options.remove } : {}),
      ...(options?.allowFailedArchiveHook ? { allowFailedArchiveHook: true } : {})
    })
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

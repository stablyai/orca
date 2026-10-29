import type { AppState } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { blockRemovalForUnsavedFiles } from './removal-unsaved-files'
import { getExecutionHostIdForFolderWorkspace } from '@/lib/folder-workspace-runtime-owner'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

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
  executionHostId?: ExecutionHostId
): Promise<boolean> | null {
  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
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
  return getState()
    .deleteFolderWorkspace(folderWorkspaceId, executionHostId ? { executionHostId } : undefined)
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
}

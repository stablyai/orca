import { FolderWorkspaceActivityPersistence } from '../../folder-workspace-activity-persistence'
import { FOLDER_WORKSPACE_ACTIVITY_PERSIST_INTERVAL_MS } from '../listing/worktree-slice-constants'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { findFolderWorkspaceMetadataOwner } from './folder-workspace-session-target'

const folderWorkspaceActivityPersistenceByStore = new WeakMap<
  WorktreeSliceGet,
  FolderWorkspaceActivityPersistence
>()

export function updateFolderWorkspaceForOwner(
  get: WorktreeSliceGet,
  folderWorkspaceId: string,
  executionHostId: ExecutionHostId,
  updates: Parameters<ReturnType<WorktreeSliceGet>['updateFolderWorkspace']>[1]
): void {
  const requiresOwner =
    get().folderWorkspaces.filter((workspace) => workspace.id === folderWorkspaceId).length > 1
  void (requiresOwner
    ? get().updateFolderWorkspace(folderWorkspaceId, updates, { executionHostId })
    : get().updateFolderWorkspace(folderWorkspaceId, updates))
}

export function getFolderWorkspaceActivityPersistence(
  get: WorktreeSliceGet
): FolderWorkspaceActivityPersistence {
  const existing = folderWorkspaceActivityPersistenceByStore.get(get)
  if (existing) {
    return existing
  }
  const created = new FolderWorkspaceActivityPersistence((persistenceKey, activityAt) => {
    const [executionHostId, folderWorkspaceId] = JSON.parse(persistenceKey) as [
      ExecutionHostId,
      string
    ]
    if (findFolderWorkspaceMetadataOwner(get(), folderWorkspaceId, executionHostId)) {
      updateFolderWorkspaceForOwner(get, folderWorkspaceId, executionHostId, {
        lastActivityAt: activityAt
      })
    }
  }, FOLDER_WORKSPACE_ACTIVITY_PERSIST_INTERVAL_MS)
  folderWorkspaceActivityPersistenceByStore.set(get, created)
  return created
}

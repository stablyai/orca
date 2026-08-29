import { FolderWorkspaceActivityPersistence } from '../../folder-workspace-activity-persistence'
import { FOLDER_WORKSPACE_ACTIVITY_PERSIST_INTERVAL_MS } from '../listing/worktree-slice-constants'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'

const folderWorkspaceActivityPersistenceByStore = new WeakMap<
  WorktreeSliceGet,
  FolderWorkspaceActivityPersistence
>()

export function getFolderWorkspaceActivityPersistence(
  get: WorktreeSliceGet
): FolderWorkspaceActivityPersistence {
  const existing = folderWorkspaceActivityPersistenceByStore.get(get)
  if (existing) {
    return existing
  }
  const created = new FolderWorkspaceActivityPersistence((folderWorkspaceId, activityAt) => {
    if (get().folderWorkspaces.some((workspace) => workspace.id === folderWorkspaceId)) {
      void get().updateFolderWorkspace(folderWorkspaceId, { lastActivityAt: activityAt })
    }
  }, FOLDER_WORKSPACE_ACTIVITY_PERSIST_INTERVAL_MS)
  folderWorkspaceActivityPersistenceByStore.set(get, created)
  return created
}

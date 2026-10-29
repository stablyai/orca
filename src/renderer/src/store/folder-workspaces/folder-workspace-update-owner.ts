import type { SessionStateCreator } from '@/store/session-source-write-boundary'
import type { AppState } from '../types'
import type { FolderWorkspaceUpdates } from '../repos/repo-state'
import { FolderWorkspaceUpdateCoordinator } from '../slices/folder-workspace-update-coordinator'

export type FolderWorkspaceUpdateField = keyof FolderWorkspaceUpdates

export type FolderWorkspaceUpdateCoordinatorInstance =
  FolderWorkspaceUpdateCoordinator<FolderWorkspaceUpdateField>

export type RepoSliceGet = Parameters<SessionStateCreator<AppState>>[1]

export const folderWorkspaceUpdateCoordinators = new WeakMap<
  RepoSliceGet,
  FolderWorkspaceUpdateCoordinatorInstance
>()

export function getFolderWorkspaceUpdateCoordinator(
  get: RepoSliceGet
): FolderWorkspaceUpdateCoordinatorInstance {
  const existing = folderWorkspaceUpdateCoordinators.get(get)
  if (existing) {
    return existing
  }
  const created = new FolderWorkspaceUpdateCoordinator<FolderWorkspaceUpdateField>()
  folderWorkspaceUpdateCoordinators.set(get, created)
  return created
}

import { resolveFolderWorkspaceCatalogOwnerHostId } from '../../../../../../shared/folder-workspaces'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  getFolderWorkspaceActivityPersistence,
  updateFolderWorkspaceForOwner
} from './folder-workspace-activity'
import { findFolderWorkspaceMetadataOwner } from './folder-workspace-session-target'

function resolveFolderTarget(get: WorktreeSliceGet, worktreeId: string) {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  const workspace = findFolderWorkspaceMetadataOwner(
    get(),
    scope.folderWorkspaceId,
    scope.ownerHostId
  )
  const ownerHostId = workspace
    ? resolveFolderWorkspaceCatalogOwnerHostId(workspace, get().projectGroups)
    : null
  return { folderWorkspaceId: scope.folderWorkspaceId, workspace, ownerHostId }
}

export function markFolderWorkspaceUnread(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet,
  worktreeId: string,
  now: number
): boolean {
  const target = resolveFolderTarget(get, worktreeId)
  if (!target) {
    return false
  }
  const { folderWorkspaceId, workspace, ownerHostId } = target
  if (!workspace || !ownerHostId || workspace.isUnread) {
    return true
  }
  let shouldPersist = false
  set((state) => {
    const current = findFolderWorkspaceMetadataOwner(state, folderWorkspaceId, ownerHostId)
    if (!current || current.isUnread) {
      return state
    }
    shouldPersist = true
    return {
      folderWorkspaces: state.folderWorkspaces.map((candidate) =>
        candidate.id === folderWorkspaceId &&
        resolveFolderWorkspaceCatalogOwnerHostId(candidate, state.projectGroups) === ownerHostId
          ? { ...candidate, isUnread: true, lastActivityAt: now }
          : candidate
      ),
      sortEpoch: state.sortEpoch + 1
    }
  })
  if (shouldPersist) {
    updateFolderWorkspaceForOwner(get, folderWorkspaceId, ownerHostId, {
      isUnread: true,
      lastActivityAt: now
    })
  }
  return true
}

export function clearFolderWorkspaceUnread(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet,
  worktreeId: string
): boolean {
  const target = resolveFolderTarget(get, worktreeId)
  if (!target) {
    return false
  }
  const { folderWorkspaceId, workspace, ownerHostId } = target
  if (!workspace?.isUnread || !ownerHostId) {
    return true
  }
  set((state) => ({
    folderWorkspaces: state.folderWorkspaces.map((candidate) =>
      candidate.id === folderWorkspaceId &&
      resolveFolderWorkspaceCatalogOwnerHostId(candidate, state.projectGroups) === ownerHostId
        ? { ...candidate, isUnread: false }
        : candidate
    )
  }))
  updateFolderWorkspaceForOwner(get, folderWorkspaceId, ownerHostId, { isUnread: false })
  return true
}

export function bumpFolderWorkspaceActivity(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet,
  worktreeId: string,
  now: number
): boolean {
  const target = resolveFolderTarget(get, worktreeId)
  if (!target) {
    return false
  }
  const { folderWorkspaceId, workspace, ownerHostId } = target
  if (!workspace || !ownerHostId) {
    return true
  }
  let shouldPersist = false
  set((state) => {
    if (!findFolderWorkspaceMetadataOwner(state, folderWorkspaceId, ownerHostId)) {
      return state
    }
    shouldPersist = true
    const isActive = state.activeWorktreeId === worktreeId
    return {
      folderWorkspaces: state.folderWorkspaces.map((candidate) =>
        candidate.id === folderWorkspaceId &&
        resolveFolderWorkspaceCatalogOwnerHostId(candidate, state.projectGroups) === ownerHostId
          ? { ...candidate, lastActivityAt: now }
          : candidate
      ),
      ...(isActive ? {} : { sortEpoch: state.sortEpoch + 1 })
    }
  })
  if (shouldPersist) {
    getFolderWorkspaceActivityPersistence(get).record(
      JSON.stringify([ownerHostId, folderWorkspaceId]),
      now
    )
  }
  return true
}

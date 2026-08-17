import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getProjectGroupHeaderKey } from '../grouping/group-keys'
import {
  buildProjectGroupOwnerIndex,
  getProjectGroupIdentity,
  getProjectGroupOwnerHostId
} from '../../../../../../shared/project-groups'
import {
  resolveFolderWorkspaceCatalogOwnerHostId,
  resolveFolderWorkspaceProjectGroupWithLegacySsh
} from '../../../../../../shared/folder-workspaces'

function findFolderWorkspaceByKey(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[] = []
): FolderWorkspace | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  const matches = folderWorkspaces.filter(
    (workspace) =>
      workspace.id === scope.folderWorkspaceId &&
      (!scope.ownerHostId ||
        resolveFolderWorkspaceCatalogOwnerHostId(workspace, projectGroups) === scope.ownerHostId)
  )
  return matches.length === 1 ? matches[0] : null
}

export function getKnownSidebarWorktreeById(
  worktreeId: string,
  worktreeMap: ReadonlyMap<string, Worktree>,
  folderWorkspaces: readonly FolderWorkspace[]
): Worktree | null {
  const worktree = worktreeMap.get(worktreeId)
  if (worktree) {
    return worktree
  }
  const folderWorkspace = findFolderWorkspaceByKey(worktreeId, folderWorkspaces)
  return folderWorkspace ? { ...folderWorkspaceToWorktree(folderWorkspace), id: worktreeId } : null
}

export function sidebarWorkspaceStillExists(
  worktreeId: string,
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[]
): boolean {
  if (worktrees.some((worktree) => worktree.id === worktreeId)) {
    return true
  }
  return findFolderWorkspaceByKey(worktreeId, folderWorkspaces) !== null
}

export function getFolderWorkspaceRevealGroupKeys(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[]
): string[] {
  const folderWorkspace = findFolderWorkspaceByKey(worktreeId, folderWorkspaces, projectGroups)
  if (!folderWorkspace) {
    return []
  }

  const index = buildProjectGroupOwnerIndex(projectGroups)
  const owningGroup = resolveFolderWorkspaceProjectGroupWithLegacySsh(index, folderWorkspace)
  if (!owningGroup) {
    return []
  }
  const ownerHostId = getProjectGroupOwnerHostId(owningGroup)
  const keys: string[] = []
  const seen = new Set<string>()
  let groupId: string | null = owningGroup.id
  while (groupId) {
    const identity = getProjectGroupIdentity(groupId, ownerHostId)
    if (seen.has(identity)) {
      break
    }
    seen.add(identity)
    const group = index.byIdentity.get(identity)
    if (!group) {
      break
    }
    keys.unshift(
      getProjectGroupHeaderKey(
        group.id,
        (index.byId.get(group.id)?.length ?? 0) > 1 ? ownerHostId : undefined
      )
    )
    groupId = group.parentGroupId
  }
  return keys
}

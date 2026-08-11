import type { FolderWorkspace, ProjectGroup, Worktree } from '../../../../shared/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildCatalogOwnerIndex } from '../../lib/catalog-owner-index'
import { buildSidebarProjectGroupOwnerIndex } from './worktree-list-project-group-owner'

function findFolderWorkspaceByKey(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  executionHostId?: ExecutionHostId | null
): FolderWorkspace | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  const resolution = buildCatalogOwnerIndex(folderWorkspaces).get(
    executionHostId ? `${scope.folderWorkspaceId}\0${executionHostId}` : scope.folderWorkspaceId
  )
  return resolution?.kind === 'resolved' ? resolution.owner : null
}

export function getKnownSidebarWorktreeById(
  worktreeId: string,
  worktreeMap: ReadonlyMap<string, Worktree>,
  folderWorkspaces: readonly FolderWorkspace[],
  executionHostId?: ExecutionHostId | null
): Worktree | null {
  const worktree = worktreeMap.get(worktreeId)
  if (worktree) {
    return worktree
  }
  const folderWorkspace = findFolderWorkspaceByKey(worktreeId, folderWorkspaces, executionHostId)
  return folderWorkspace ? folderWorkspaceToWorktree(folderWorkspace) : null
}

export function sidebarWorkspaceStillExists(
  worktreeId: string,
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[],
  executionHostId?: ExecutionHostId | null
): boolean {
  if (worktrees.some((worktree) => worktree.id === worktreeId)) {
    return true
  }
  return findFolderWorkspaceByKey(worktreeId, folderWorkspaces, executionHostId) !== null
}

export function getFolderWorkspaceRevealGroupKeys(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  executionHostId?: ExecutionHostId | null
): string[] {
  const folderWorkspace = findFolderWorkspaceByKey(worktreeId, folderWorkspaces, executionHostId)
  if (!folderWorkspace) {
    return []
  }

  const ownerIndex = buildSidebarProjectGroupOwnerIndex(projectGroups)
  const owningGroup = ownerIndex.findFolderProjectGroup(folderWorkspace)
  if (!owningGroup) {
    return []
  }
  const keys: string[] = []
  const seen = new Set<ProjectGroup>()
  let group: ProjectGroup | null = owningGroup
  while (group && !seen.has(group)) {
    seen.add(group)
    keys.unshift(ownerIndex.getHeaderKey(group))
    group = ownerIndex.findParentProjectGroup(group)
  }
  return keys
}

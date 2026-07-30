import type {
  FolderWorkspace,
  ProjectGroup,
  Worktree,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  getFolderWorkspaceSidebarGroupKey,
  getProjectGroupHeaderKey,
  PINNED_GROUP_KEY,
  type PinnedWorktreeDisplayPolicy,
  type WorktreeGroupBy
} from './worktree-list-groups'
import { getFolderWorkspaceExecutionHostIdForRows } from './worktree-list-host-filtering'

function findFolderWorkspaceByKey(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[]
): FolderWorkspace | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  return folderWorkspaces.find((workspace) => workspace.id === scope.folderWorkspaceId) ?? null
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
  return folderWorkspace ? folderWorkspaceToWorktree(folderWorkspace) : null
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
  projectGroups: readonly ProjectGroup[],
  groupBy: WorktreeGroupBy = 'repo',
  workspaceStatuses: readonly WorkspaceStatusDefinition[] = [],
  defaultHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID,
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy = 'single-location'
): string[] {
  const folderWorkspace = findFolderWorkspaceByKey(worktreeId, folderWorkspaces)
  if (!folderWorkspace) {
    return []
  }

  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const owningGroup = groupsById.get(folderWorkspace.projectGroupId)
  // Why: folder reveal resolves all ancestors here, including its host section.
  const keys: string[] = [
    `host:${getFolderWorkspaceExecutionHostIdForRows({
      folderWorkspace,
      projectGroup: owningGroup,
      defaultHostId
    })}`
  ]

  // Why: single-location has no natural copy to reveal for pinned folders.
  if (folderWorkspace.isPinned && pinnedDisplayPolicy === 'single-location') {
    keys.push(PINNED_GROUP_KEY)
    return keys
  }

  // Why: non-repo grouping owns folder rows through its flat lane header.
  if (groupBy !== 'repo') {
    const laneKey = getFolderWorkspaceSidebarGroupKey(groupBy, folderWorkspace, workspaceStatuses)
    if (laneKey) {
      keys.push(laneKey)
    }
    return keys
  }

  const groupKeys: string[] = []
  const seen = new Set<string>()
  let groupId: string | null = folderWorkspace.projectGroupId
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId)
    const group = groupsById.get(groupId)
    if (!group) {
      break
    }
    groupKeys.unshift(getProjectGroupHeaderKey(group.id))
    groupId = group.parentGroupId
  }
  keys.push(...groupKeys)
  return keys
}

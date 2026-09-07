import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getProjectGroupHeaderKey } from '../grouping/group-keys'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getFolderWorkspaceLaneKey } from '../grouping/folder-workspace-lanes'
import type { WorktreeGroupBy } from '../grouping/row-types'
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'

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
  folderWorkspaces: readonly FolderWorkspace[],
  worktrees?: readonly Worktree[],
  executionHostId?: ExecutionHostId | null
): Worktree | null {
  const worktree = executionHostId
    ? (worktrees?.find(
        (candidate) => candidate.id === worktreeId && candidate.hostId === executionHostId
      ) ?? null)
    : worktreeMap.get(worktreeId)
  if (worktree) {
    return worktree
  }
  const folderWorkspace = findFolderWorkspaceByKey(worktreeId, folderWorkspaces)
  return folderWorkspace ? folderWorkspaceToWorktree(folderWorkspace) : null
}

export function sidebarWorkspaceStillExists(
  worktreeId: string,
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[],
  executionHostId?: ExecutionHostId
): boolean {
  if (
    worktrees.some(
      (worktree) =>
        worktree.id === worktreeId &&
        (!executionHostId || !worktree.hostId || worktree.hostId === executionHostId)
    )
  ) {
    return true
  }
  return findFolderWorkspaceByKey(worktreeId, folderWorkspaces) !== null
}

export function getFolderWorkspaceRevealGroupKeys(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  options?: {
    groupBy?: WorktreeGroupBy
    workspaceStatuses?: readonly WorkspaceStatusDefinition[]
    defaultHostId?: ExecutionHostId
  }
): string[] {
  const folderWorkspace = findFolderWorkspaceByKey(worktreeId, folderWorkspaces)
  if (!folderWorkspace) {
    return []
  }

  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const keys: string[] = []
  const seen = new Set<string>()
  let groupId: string | null = folderWorkspace.projectGroupId
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId)
    const group = groupsById.get(groupId)
    if (!group) {
      break
    }
    keys.unshift(getProjectGroupHeaderKey(group.id))
    groupId = group.parentGroupId
  }

  // Under non-repo grouping the project-group headers above do not exist, so the
  // lane and host headers are the ones actually hiding the row (#15362). Lane
  // keys come from the same function grouping uses, so the two cannot disagree.
  const owningGroup = groupsById.get(folderWorkspace.projectGroupId)
  if (options?.groupBy && options.groupBy !== 'repo' && owningGroup) {
    keys.push(
      getFolderWorkspaceLaneKey(
        { folderWorkspace, projectGroup: owningGroup },
        options.groupBy,
        options.workspaceStatuses ?? []
      )
    )
  }
  if (owningGroup && options?.defaultHostId) {
    keys.push(
      `host:${getFolderWorkspaceHostId(folderWorkspace, owningGroup, options.defaultHostId)}`
    )
  }
  return keys
}

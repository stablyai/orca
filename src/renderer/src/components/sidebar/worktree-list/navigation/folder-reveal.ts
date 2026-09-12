import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getProjectGroupHeaderKey } from '../grouping/group-keys'
import {
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getFolderWorkspaceLaneKey } from '../grouping/folder-workspace-lanes'
import { getGroupKeyForWorktree } from '../grouping/worktree-group-keys'
import type { WorktreeGroupBy } from '../grouping/row-types'
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'
import { getFolderWorkspaceExecutionHostIdForRows } from '../listing/host-filtering'

function findFolderWorkspaceByKey(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  executionHostId?: ExecutionHostId | null,
  projectGroups?: readonly ProjectGroup[],
  defaultHostId?: ExecutionHostId
): FolderWorkspace | null {
  const scope = parseWorkspaceKey(worktreeId)
  const targetId = scope ? (scope.type === 'folder' ? scope.folderWorkspaceId : null) : worktreeId
  if (!targetId) {
    return null
  }
  const matchingWorkspaces = folderWorkspaces.filter((workspace) => workspace.id === targetId)
  if (matchingWorkspaces.length === 0) {
    return null
  }
  if (!executionHostId) {
    return matchingWorkspaces[0]
  }
  const groupsById = projectGroups ? new Map(projectGroups.map((group) => [group.id, group])) : null
  return (
    matchingWorkspaces.find((workspace) => {
      const owningGroup = groupsById?.get(workspace.projectGroupId)
      const workspaceHostId = getFolderWorkspaceExecutionHostIdForRows({
        folderWorkspace: workspace,
        projectGroup: owningGroup,
        defaultHostId: defaultHostId ?? LOCAL_EXECUTION_HOST_ID
      })
      return workspaceHostId === executionHostId
    }) ?? null
  )
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
  const folderWorkspace = findFolderWorkspaceByKey(worktreeId, folderWorkspaces, executionHostId)
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
  return findFolderWorkspaceByKey(worktreeId, folderWorkspaces, executionHostId) !== null
}

export function getFolderWorkspaceRevealGroupKeys(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  options?: {
    groupBy?: WorktreeGroupBy
    workspaceStatuses?: readonly WorkspaceStatusDefinition[]
    defaultHostId?: ExecutionHostId
    worktrees?: readonly Worktree[]
    repoMap?: ReadonlyMap<string, Repo>
    executionHostId?: ExecutionHostId | null
  }
): string[] {
  const folderWorkspace = findFolderWorkspaceByKey(
    worktreeId,
    folderWorkspaces,
    options?.executionHostId,
    projectGroups,
    options?.defaultHostId
  )
  if (folderWorkspace) {
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

  if (options?.worktrees && options?.repoMap) {
    const targetWorktree = options.worktrees.find(
      (worktree) =>
        worktree.id === worktreeId &&
        (!options.executionHostId ||
          !worktree.hostId ||
          worktree.hostId === options.executionHostId)
    )
    if (targetWorktree) {
      const repo = options.repoMap.get(targetWorktree.repoId)
      if (repo) {
        const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
        const keys: string[] = []
        const seen = new Set<string>()
        let groupId: string | null = repo.projectGroupId ?? null
        while (groupId && !seen.has(groupId)) {
          seen.add(groupId)
          const group = groupsById.get(groupId)
          if (!group) {
            break
          }
          keys.unshift(getProjectGroupHeaderKey(group.id))
          groupId = group.parentGroupId
        }
        if (!options?.groupBy || options.groupBy === 'repo') {
          keys.push(`project:${repo.id}`)
        } else {
          const laneKey = getGroupKeyForWorktree(
            options.groupBy,
            targetWorktree,
            options.repoMap as Map<string, Repo>,
            null,
            options.workspaceStatuses
          )
          if (laneKey) {
            keys.push(laneKey)
          }
          if (options.defaultHostId) {
            keys.push(
              `host:${getWorktreeExecutionHostId(targetWorktree, repo, options.defaultHostId)}`
            )
          }
        }
        return keys
      }
    }
  }

  return []
}

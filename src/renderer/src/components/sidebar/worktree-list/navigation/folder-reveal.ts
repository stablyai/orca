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
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getFolderWorkspaceLaneKey } from '../grouping/folder-workspace-lanes'
import { getGroupKeysForWorktree } from '../grouping/worktree-group-keys'
import type { ProjectGroupingModel } from '../grouping/project-grouping'
import type { WorktreeGroupBy } from '../grouping/row-types'
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'
import { getFolderWorkspaceExecutionHostIdForRows } from '../listing/host-filtering'
import type { AppState } from '@/store/types'

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
  if (!projectGroups) {
    return (
      matchingWorkspaces.find((workspace) => {
        const workspaceHostId =
          normalizeExecutionHostId(workspace.executionHostId) ??
          (workspace.connectionId ? toSshExecutionHostId(workspace.connectionId) : null)
        return workspaceHostId === executionHostId
      }) ?? null
    )
  }
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  return (
    matchingWorkspaces.find((workspace) => {
      const owningGroup = groupsById.get(workspace.projectGroupId)
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
  executionHostId?: ExecutionHostId | null,
  projectGroups?: readonly ProjectGroup[],
  defaultHostId?: ExecutionHostId,
  repoMap?: ReadonlyMap<string, Repo>
): Worktree | null {
  const worktree = executionHostId
    ? (worktrees?.find((candidate) => {
        if (candidate.id !== worktreeId) {
          return false
        }
        if (repoMap) {
          const repo = repoMap.get(candidate.repoId)
          return (
            getWorktreeExecutionHostId(
              candidate,
              repo,
              defaultHostId ?? LOCAL_EXECUTION_HOST_ID
            ) === executionHostId
          )
        }
        return candidate.hostId ? candidate.hostId === executionHostId : false
      }) ?? null)
    : worktreeMap.get(worktreeId)
  if (worktree) {
    return worktree
  }
  const folderWorkspace = findFolderWorkspaceByKey(
    worktreeId,
    folderWorkspaces,
    executionHostId,
    projectGroups,
    defaultHostId
  )
  return folderWorkspace ? folderWorkspaceToWorktree(folderWorkspace) : null
}

export function sidebarWorkspaceStillExists(
  worktreeId: string,
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[],
  executionHostId?: ExecutionHostId,
  projectGroups?: readonly ProjectGroup[],
  defaultHostId?: ExecutionHostId,
  repoMap?: ReadonlyMap<string, Repo>
): boolean {
  if (
    worktrees.some((worktree) => {
      if (worktree.id !== worktreeId) {
        return false
      }
      if (!executionHostId) {
        return true
      }
      if (repoMap) {
        const repo = repoMap.get(worktree.repoId)
        return (
          getWorktreeExecutionHostId(worktree, repo, defaultHostId ?? LOCAL_EXECUTION_HOST_ID) ===
          executionHostId
        )
      }
      return worktree.hostId ? worktree.hostId === executionHostId : false
    })
  ) {
    return true
  }
  return (
    findFolderWorkspaceByKey(
      worktreeId,
      folderWorkspaces,
      executionHostId,
      projectGroups,
      defaultHostId
    ) !== null
  )
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
    prCache?: Record<string, unknown> | null
    settings?: AppState['settings']
    projectGrouping?: ProjectGroupingModel
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
    const defaultHostId = options.defaultHostId ?? LOCAL_EXECUTION_HOST_ID
    const targetWorktree = options.worktrees.find((worktree) => {
      if (worktree.id !== worktreeId) {
        return false
      }
      if (!options.executionHostId) {
        return true
      }
      const repo = options.repoMap?.get(worktree.repoId)
      const effectiveHost = getWorktreeExecutionHostId(worktree, repo, defaultHostId)
      return effectiveHost === options.executionHostId
    })
    if (targetWorktree) {
      const repo = options.repoMap.get(targetWorktree.repoId)
      if (repo) {
        const groupKeys = getGroupKeysForWorktree(
          options?.groupBy ?? 'repo',
          targetWorktree,
          options.repoMap as Map<string, Repo>,
          options?.prCache ?? null,
          options?.workspaceStatuses,
          options?.settings,
          projectGroups,
          options?.projectGrouping
        )
        const hostGroupKey = `host:${getWorktreeExecutionHostId(targetWorktree, repo, defaultHostId)}`
        return [...groupKeys, hostGroupKey]
      }
    }
  }

  return []
}

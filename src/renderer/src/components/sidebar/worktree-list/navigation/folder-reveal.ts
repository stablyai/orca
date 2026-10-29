import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import {
  folderWorkspaceToWorktree,
  getFolderWorkspaceHostIdentity
} from '../../../../../../shared/folder-workspace-worktree'
import {
  normalizeWorkspaceSessionKeyToWorkspaceId,
  parseWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getNestedGroupKey,
  getProjectGroupHeaderKey
} from '../../../../../../shared/sidebar-list/group-keys'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getFolderWorkspaceLaneKey } from '../../../../../../shared/sidebar-list/folder-workspace-lanes'
import type {
  WorktreeGroupBy,
  WorktreeGroupBySecondary
} from '../../../../../../shared/sidebar-list/row-types'
import { getFolderWorkspaceHostId } from '../../../../../../shared/sidebar-list/folder-workspace-host-id'
import { getHostSectionCollapseKey } from '../../../../../../shared/sidebar-list/host-section-collapse'

function findFolderWorkspaceByKey(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  executionHostId?: ExecutionHostId | null
): FolderWorkspace | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  return (
    folderWorkspaces.find(
      (workspace) =>
        workspace.id === scope.folderWorkspaceId &&
        (!executionHostId ||
          getFolderWorkspaceHostIdentity(workspace) ===
            composeWorktreeHostIdentity(executionHostId, worktreeId))
    ) ?? null
  )
}

export function getKnownSidebarWorktreeById(
  worktreeId: string,
  worktreeMap: ReadonlyMap<string, Worktree>,
  folderWorkspaces: readonly FolderWorkspace[],
  worktrees?: readonly Worktree[],
  executionHostId?: ExecutionHostId | null
): Worktree | null {
  const workspaceId = normalizeWorkspaceSessionKeyToWorkspaceId(worktreeId)
  const ownerHostId = getExecutionHostIdFromWorktreeHostIdentity(worktreeId) ?? executionHostId
  const worktree = ownerHostId
    ? (worktrees?.find(
        (candidate) => candidate.id === workspaceId && candidate.hostId === ownerHostId
      ) ?? null)
    : worktreeMap.get(workspaceId)
  if (worktree) {
    return worktree
  }
  const folderWorkspace = findFolderWorkspaceByKey(workspaceId, folderWorkspaces, ownerHostId)
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
    groupBySecondary?: WorktreeGroupBySecondary
    workspaceStatuses?: readonly WorkspaceStatusDefinition[]
    defaultHostId?: ExecutionHostId
    hostScopedGroups?: boolean
    executionHostId?: ExecutionHostId
  }
): string[] {
  const folderWorkspace = findFolderWorkspaceByKey(
    worktreeId,
    folderWorkspaces,
    options?.executionHostId
  )
  if (!folderWorkspace) {
    return []
  }

  const groupsById = new Map(
    projectGroups
      .filter(
        (group) =>
          !options?.executionHostId || getRepoExecutionHostId(group) === options.executionHostId
      )
      .map((group) => [group.id, group])
  )
  // Resolve parents from the unfiltered last same-ID group copy, matching the hostless headers the sidebar renders.
  const renderedGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const keys: string[] = []
  const seen = new Set<string>()
  let groupId: string | null = groupsById.has(folderWorkspace.projectGroupId)
    ? folderWorkspace.projectGroupId
    : null
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId)
    const group = renderedGroupsById.get(groupId)
    if (!group) {
      break
    }
    keys.unshift(getProjectGroupHeaderKey(group.id))
    groupId = group.parentGroupId
  }

  const owningGroup = groupsById.get(folderWorkspace.projectGroupId)
  const ownerHostId =
    owningGroup && options?.defaultHostId
      ? getFolderWorkspaceHostId(folderWorkspace, owningGroup, options.defaultHostId)
      : null
  const sectionKey = (key: string): string =>
    options?.hostScopedGroups && ownerHostId ? getHostSectionCollapseKey(key, ownerHostId) : key
  const secondaryGroupBy =
    options?.groupBySecondary !== options?.groupBy ? options?.groupBySecondary : 'none'
  if (
    options?.groupBy === 'repo' &&
    secondaryGroupBy &&
    secondaryGroupBy !== 'none' &&
    secondaryGroupBy !== 'repo' &&
    owningGroup
  ) {
    const secondaryLaneKey = getFolderWorkspaceLaneKey(
      { folderWorkspace, projectGroup: owningGroup },
      secondaryGroupBy,
      options.workspaceStatuses ?? []
    )
    keys.push(
      sectionKey(getNestedGroupKey(getProjectGroupHeaderKey(owningGroup.id), secondaryLaneKey))
    )
  }

  // Under non-Project grouping the unqualified Project Group headers above do
  // not exist. A Project secondary restores that hierarchy, with every key
  // qualified by its primary lane so collapse state stays independent.
  if (options?.groupBy && options.groupBy !== 'repo' && owningGroup) {
    const laneKey = getFolderWorkspaceLaneKey(
      { folderWorkspace, projectGroup: owningGroup },
      options.groupBy,
      options.workspaceStatuses ?? []
    )
    if (secondaryGroupBy === 'repo') {
      keys.splice(
        0,
        keys.length,
        sectionKey(laneKey),
        ...keys.map((key) => sectionKey(getNestedGroupKey(laneKey, key)))
      )
    } else if (secondaryGroupBy && secondaryGroupBy !== 'none') {
      const secondaryLaneKey = getFolderWorkspaceLaneKey(
        { folderWorkspace, projectGroup: owningGroup },
        secondaryGroupBy,
        options.workspaceStatuses ?? []
      )
      keys.splice(
        0,
        keys.length,
        sectionKey(laneKey),
        sectionKey(getNestedGroupKey(laneKey, secondaryLaneKey))
      )
    } else {
      keys.splice(0, keys.length, sectionKey(laneKey))
    }
  }
  if (ownerHostId) {
    keys.push(`host:${ownerHostId}`)
  }
  return keys
}

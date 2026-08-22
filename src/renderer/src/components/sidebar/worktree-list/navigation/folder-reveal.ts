import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { folderWorkspaceToWorktreeForHost } from '../../../../../../shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getProjectGroupHeaderKey } from '../grouping/group-keys'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getFolderWorkspaceLaneKey } from '../grouping/folder-workspace-lanes'
import type { WorktreeGroupBy } from '../grouping/row-types'
import {
  findFolderWorkspaceProjectGroup,
  getFolderWorkspaceHostId,
  getProjectGroupHostId
} from '../../../../../../shared/folder-workspace-host'

function findFolderWorkspaceByKey(
  worktreeId: string,
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  defaultHostId: ExecutionHostId,
  executionHostId?: ExecutionHostId | null
): { folderWorkspace: FolderWorkspace; projectGroup: ProjectGroup | null } | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  for (const folderWorkspace of folderWorkspaces) {
    if (folderWorkspace.id !== scope.folderWorkspaceId) {
      continue
    }
    const projectGroup = findFolderWorkspaceProjectGroup(
      folderWorkspace,
      projectGroups,
      defaultHostId
    )
    const hostId = getFolderWorkspaceHostId(folderWorkspace, projectGroup, defaultHostId)
    if (!executionHostId || hostId === executionHostId) {
      return { folderWorkspace, projectGroup }
    }
  }
  return null
}

export function getKnownSidebarWorktreeById(
  worktreeId: string,
  worktreeMap: ReadonlyMap<string, Worktree>,
  folderWorkspaces: readonly FolderWorkspace[],
  worktrees?: readonly Worktree[],
  executionHostId?: ExecutionHostId | null,
  projectGroups: readonly ProjectGroup[] = [],
  defaultHostId: ExecutionHostId = executionHostId ?? LOCAL_EXECUTION_HOST_ID
): Worktree | null {
  const worktree = executionHostId
    ? (worktrees?.find(
        (candidate) => candidate.id === worktreeId && candidate.hostId === executionHostId
      ) ?? null)
    : worktreeMap.get(worktreeId)
  if (worktree) {
    return worktree
  }
  const folder = findFolderWorkspaceByKey(
    worktreeId,
    folderWorkspaces,
    projectGroups,
    defaultHostId,
    executionHostId
  )
  if (!folder) {
    return null
  }
  const hostId = getFolderWorkspaceHostId(
    folder.folderWorkspace,
    folder.projectGroup,
    defaultHostId
  )
  return folderWorkspaceToWorktreeForHost(folder.folderWorkspace, hostId)
}

export function sidebarWorkspaceStillExists(
  worktreeId: string,
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[],
  executionHostId?: ExecutionHostId,
  projectGroups: readonly ProjectGroup[] = [],
  defaultHostId: ExecutionHostId = executionHostId ?? LOCAL_EXECUTION_HOST_ID
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
  return (
    findFolderWorkspaceByKey(
      worktreeId,
      folderWorkspaces,
      projectGroups,
      defaultHostId,
      executionHostId
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
    executionHostId?: ExecutionHostId
  }
): string[] {
  const defaultHostId = options?.defaultHostId ?? LOCAL_EXECUTION_HOST_ID
  const folder = findFolderWorkspaceByKey(
    worktreeId,
    folderWorkspaces,
    projectGroups,
    defaultHostId,
    options?.executionHostId
  )
  if (!folder?.projectGroup) {
    return []
  }
  const { folderWorkspace, projectGroup: owningGroup } = folder
  const targetHostId = getFolderWorkspaceHostId(folderWorkspace, owningGroup, defaultHostId)
  const groupsById = new Map<string, ProjectGroup[]>()
  for (const group of projectGroups) {
    const matching = groupsById.get(group.id) ?? []
    matching.push(group)
    groupsById.set(group.id, matching)
  }
  const getGroupForHost = (groupId: string): ProjectGroup | null => {
    const matching = groupsById.get(groupId) ?? []
    const hostMatches = matching.filter(
      (group) => getProjectGroupHostId(group, defaultHostId) === targetHostId
    )
    return hostMatches.length === 1 ? hostMatches[0]! : matching.length === 1 ? matching[0]! : null
  }
  const getHeaderKey = (group: ProjectGroup): string =>
    getProjectGroupHeaderKey(
      (groupsById.get(group.id)?.length ?? 0) > 1
        ? JSON.stringify([getProjectGroupHostId(group, defaultHostId), group.id])
        : group.id
    )
  const keys: string[] = []
  const seen = new Set<string>()
  let group: ProjectGroup | null = owningGroup
  while (group && !seen.has(getHeaderKey(group))) {
    const key = getHeaderKey(group)
    seen.add(key)
    keys.unshift(key)
    group = group.parentGroupId ? getGroupForHost(group.parentGroupId) : null
  }

  // Under non-repo grouping the project-group headers above do not exist, so the
  // lane and host headers are the ones actually hiding the row (#15362). Lane
  // keys come from the same function grouping uses, so the two cannot disagree.
  if (options?.groupBy && options.groupBy !== 'repo' && owningGroup) {
    keys.push(
      getFolderWorkspaceLaneKey(
        { folderWorkspace, projectGroup: owningGroup },
        options.groupBy,
        options.workspaceStatuses ?? []
      )
    )
  }
  if (options?.defaultHostId) {
    keys.push(`host:${targetHostId}`)
  }
  return keys
}

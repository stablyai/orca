import {
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'

export function getProjectGroupHostId(
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return (
    normalizeExecutionHostId(projectGroup.executionHostId) ??
    (projectGroup.connectionId ? toSshExecutionHostId(projectGroup.connectionId) : defaultHostId)
  )
}

export function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'> | null | undefined,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  const executionHostId =
    normalizeExecutionHostId(folderWorkspace.executionHostId) ??
    normalizeExecutionHostId(projectGroup?.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  const connectionId = folderWorkspace.connectionId ?? projectGroup?.connectionId
  return connectionId ? toSshExecutionHostId(connectionId) : defaultHostId
}

export function getFolderWorkspaceHostIdFromGroups(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId' | 'projectGroupId'>,
  projectGroups: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[],
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  const matchingGroups = projectGroups.filter(
    (group) => group.id === folderWorkspace.projectGroupId
  )
  if (matchingGroups.length <= 1) {
    return getFolderWorkspaceHostId(folderWorkspace, matchingGroups[0], defaultHostId)
  }
  const folderHostId = normalizeExecutionHostId(folderWorkspace.executionHostId)
  if (folderHostId) {
    return folderHostId
  }
  const resolvedGroupHostIds = new Set(
    matchingGroups.map((group) => getFolderWorkspaceHostId(folderWorkspace, group, defaultHostId))
  )
  if (resolvedGroupHostIds.size === 1) {
    return [...resolvedGroupHostIds][0]!
  }
  if (folderWorkspace.connectionId) {
    return toSshExecutionHostId(folderWorkspace.connectionId)
  }
  return defaultHostId
}

export function findFolderWorkspaceProjectGroup(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId' | 'projectGroupId'>,
  projectGroups: readonly ProjectGroup[],
  defaultHostId: ExecutionHostId
): ProjectGroup | null {
  const matchingGroups = projectGroups.filter(
    (group) => group.id === folderWorkspace.projectGroupId
  )
  if (matchingGroups.length <= 1) {
    return matchingGroups[0] ?? null
  }
  const targetHostId = getFolderWorkspaceHostIdFromGroups(
    folderWorkspace,
    matchingGroups,
    defaultHostId
  )
  const exactHostMatches = matchingGroups.filter(
    (group) => normalizeExecutionHostId(group.executionHostId) === targetHostId
  )
  if (exactHostMatches.length === 1) {
    return exactHostMatches[0]!
  }
  if (folderWorkspace.connectionId) {
    const connectionMatches = matchingGroups.filter(
      (group) => group.connectionId === folderWorkspace.connectionId
    )
    if (connectionMatches.length === 1) {
      return connectionMatches[0]!
    }
  }
  const compatibleGroups = matchingGroups.filter(
    (group) => getFolderWorkspaceHostId(folderWorkspace, group, defaultHostId) === targetHostId
  )
  return compatibleGroups.length === 1 ? compatibleGroups[0]! : null
}

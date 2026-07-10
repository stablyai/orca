import {
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspacePathStatusRequest } from '../../../../shared/folder-workspace-path-status'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'

export function getProjectGroupExecutionHostIdForRows(
  group: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(group.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  return group.connectionId ? toSshExecutionHostId(group.connectionId) : defaultHostId
}

export function getFolderWorkspaceExecutionHostIdForRows({
  folderWorkspace,
  projectGroup,
  defaultHostId
}: {
  folderWorkspace: Pick<FolderWorkspace, 'connectionId'>
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'> | undefined
  defaultHostId: ExecutionHostId
}): ExecutionHostId {
  if (projectGroup) {
    const explicitProjectGroupHostId = normalizeExecutionHostId(projectGroup.executionHostId)
    if (explicitProjectGroupHostId) {
      return explicitProjectGroupHostId
    }
    const projectGroupHostId = getProjectGroupExecutionHostIdForRows(projectGroup, defaultHostId)
    if (projectGroupHostId !== defaultHostId || !folderWorkspace.connectionId) {
      return projectGroupHostId
    }
  }
  return folderWorkspace.connectionId
    ? toSshExecutionHostId(folderWorkspace.connectionId)
    : defaultHostId
}

export function getRuntimeEnvironmentIdForFolderPathStatusHost(
  hostId: ExecutionHostId
): string | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

function getProjectGroupExecutionHostIdForFolderPathStatus(
  group: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(group.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  return group.connectionId ? toSshExecutionHostId(group.connectionId) : 'local'
}

export function getFolderPathStatusRouteOptionsForRows({
  request,
  projectGroupsById,
  folderWorkspacesById
}: {
  request: FolderWorkspacePathStatusRequest
  projectGroupsById: ReadonlyMap<string, ProjectGroup>
  folderWorkspacesById: ReadonlyMap<string, FolderWorkspace>
}): { runtimeEnvironmentId: string | null } | undefined {
  const folderWorkspace =
    request.scope === 'folder-workspace'
      ? folderWorkspacesById.get(request.folderWorkspaceId)
      : undefined
  const group =
    request.scope === 'project-group'
      ? projectGroupsById.get(request.projectGroupId)
      : projectGroupsById.get(folderWorkspace?.projectGroupId ?? '')
  if (!group) {
    return undefined
  }
  const hostId =
    request.scope === 'project-group'
      ? getProjectGroupExecutionHostIdForFolderPathStatus(group)
      : getFolderWorkspaceExecutionHostIdForRows({
          folderWorkspace: folderWorkspace ?? { connectionId: null },
          projectGroup: group,
          defaultHostId: getProjectGroupExecutionHostIdForFolderPathStatus(group)
        })
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForFolderPathStatusHost(hostId)
  return { runtimeEnvironmentId }
}

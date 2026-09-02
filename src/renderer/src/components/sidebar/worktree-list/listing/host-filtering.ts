import {
  ALL_EXECUTION_HOSTS_SCOPE,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../../../shared/execution-host'
import type { FolderWorkspacePathStatusRequest } from '../../../../../../shared/folder-workspace-path-status'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

/** null means "no host filter" — every host is visible. */
export function getVisibleSidebarHostIdSet(
  visibleWorkspaceHostIds: readonly ExecutionHostId[] | null | undefined,
  workspaceHostScope: ExecutionHostScope
): Set<ExecutionHostId> | null {
  const visibleHostIds =
    visibleWorkspaceHostIds ??
    (workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [workspaceHostScope])
  return visibleHostIds ? new Set<ExecutionHostId>(visibleHostIds) : null
}

// Why shared: the sidebar render path and the Cmd+1–9 order must apply the same
// host filtering, or the numbering drifts from the cards whenever a filter is on.
export function filterProjectGroupsForVisibleHosts(
  projectGroups: readonly ProjectGroup[],
  visibleHostIdSet: ReadonlySet<ExecutionHostId> | null,
  defaultHostId: ExecutionHostId
): readonly ProjectGroup[] {
  if (!visibleHostIdSet) {
    return projectGroups
  }
  return projectGroups.filter((group) =>
    visibleHostIdSet.has(getProjectGroupExecutionHostIdForRows(group, defaultHostId))
  )
}

export function filterFolderWorkspacesForVisibleHosts(
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  visibleHostIdSet: ReadonlySet<ExecutionHostId> | null,
  defaultHostId: ExecutionHostId
): readonly FolderWorkspace[] {
  if (!visibleHostIdSet) {
    return folderWorkspaces
  }
  const projectGroupById = new Map(projectGroups.map((group) => [group.id, group]))
  return folderWorkspaces.filter((folderWorkspace) =>
    visibleHostIdSet.has(
      getFolderWorkspaceExecutionHostIdForRows({
        folderWorkspace,
        projectGroup: projectGroupById.get(folderWorkspace.projectGroupId),
        defaultHostId
      })
    )
  )
}

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
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'> | undefined
  defaultHostId: ExecutionHostId
}): ExecutionHostId {
  const explicitFolderHostId = normalizeExecutionHostId(folderWorkspace.executionHostId)
  if (explicitFolderHostId) {
    return explicitFolderHostId
  }
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
          folderWorkspace: folderWorkspace ?? { connectionId: null, executionHostId: null },
          projectGroup: group,
          defaultHostId: getProjectGroupExecutionHostIdForFolderPathStatus(group)
        })
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForFolderPathStatusHost(hostId)
  return { runtimeEnvironmentId }
}

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
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'
import { getFolderWorkspaceHostIdFromGroups } from '../../../../../../shared/folder-workspace-host'

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
  return folderWorkspaces.filter((folderWorkspace) =>
    visibleHostIdSet.has(
      getFolderWorkspaceHostIdFromGroups(folderWorkspace, projectGroups, defaultHostId)
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
  return getFolderWorkspaceHostId(folderWorkspace, projectGroup, defaultHostId)
}

export function getRuntimeEnvironmentIdForFolderPathStatusHost(
  hostId: ExecutionHostId
): string | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

export function getFolderPathStatusRouteOptionsForHost(hostId: ExecutionHostId): {
  runtimeEnvironmentId: string | null
} {
  return { runtimeEnvironmentId: getRuntimeEnvironmentIdForFolderPathStatusHost(hostId) }
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
  projectGroup,
  folderWorkspace
}: {
  request: FolderWorkspacePathStatusRequest
  projectGroup: ProjectGroup | null | undefined
  folderWorkspace?: FolderWorkspace
}): { runtimeEnvironmentId: string | null } | undefined {
  if (request.scope === 'project-group' && !projectGroup) {
    return undefined
  }
  const hostId =
    request.scope === 'project-group'
      ? getProjectGroupExecutionHostIdForFolderPathStatus(projectGroup!)
      : getFolderWorkspaceExecutionHostIdForRows({
          folderWorkspace: folderWorkspace ?? { connectionId: null, executionHostId: null },
          projectGroup: projectGroup ?? undefined,
          defaultHostId: projectGroup
            ? getProjectGroupExecutionHostIdForFolderPathStatus(projectGroup)
            : 'local'
        })
  return getFolderPathStatusRouteOptionsForHost(hostId)
}

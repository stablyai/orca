import {
  ALL_EXECUTION_HOSTS_SCOPE,
  parseExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import { resolveFolderWorkspaceExecutionHostId } from '../../lib/folder-workspace-execution-host'
import { buildSidebarProjectGroupOwnerIndex } from './worktree-list-project-group-owner'

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
  return projectGroups.filter((group) => {
    const hostId = getProjectGroupExecutionHostIdForRows(group, defaultHostId)
    return hostId ? visibleHostIdSet.has(hostId) : false
  })
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
  const groupOwnerIndex = buildSidebarProjectGroupOwnerIndex(projectGroups)
  return folderWorkspaces.filter((folderWorkspace) => {
    const projectGroup = groupOwnerIndex.findFolderProjectGroup(folderWorkspace)
    const hostId = getFolderWorkspaceExecutionHostIdForRows({
      folderWorkspace,
      projectGroup: projectGroup ?? undefined,
      defaultHostId
    })
    return hostId ? visibleHostIdSet.has(hostId) : false
  })
}

export function getProjectGroupExecutionHostIdForRows(
  group: Pick<ProjectGroup, 'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId | null {
  return resolveFolderWorkspaceExecutionHostId({
    folderWorkspace: {},
    projectGroup: group,
    fallbackHostId: defaultHostId
  })
}

export function getFolderWorkspaceExecutionHostIdForRows({
  folderWorkspace,
  projectGroup,
  defaultHostId
}: {
  folderWorkspace: Pick<
    FolderWorkspace,
    'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
  >
  projectGroup:
    | Pick<ProjectGroup, 'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'>
    | undefined
  defaultHostId: ExecutionHostId
}): ExecutionHostId | null {
  return resolveFolderWorkspaceExecutionHostId({
    folderWorkspace,
    projectGroup,
    fallbackHostId: defaultHostId
  })
}

export function getRuntimeEnvironmentIdForFolderPathStatusHost(
  hostId: ExecutionHostId
): string | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

export function getFolderPathStatusRouteOptionsForRows({
  projectGroup,
  folderWorkspace
}: {
  projectGroup?: Pick<
    ProjectGroup,
    'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
  >
  folderWorkspace?: Pick<
    FolderWorkspace,
    'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
  >
}): { runtimeEnvironmentId: string | null } | undefined {
  if (!projectGroup && !folderWorkspace) {
    return undefined
  }
  const projectGroupHostId = projectGroup
    ? getProjectGroupExecutionHostIdForRows(projectGroup, 'local')
    : undefined
  const hostId = folderWorkspace
    ? resolveFolderWorkspaceExecutionHostId({
        folderWorkspace,
        projectGroup,
        fallbackHostId: projectGroupHostId
      })
    : projectGroupHostId
  if (!hostId) {
    return undefined
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForFolderPathStatusHost(hostId)
  return { runtimeEnvironmentId }
}

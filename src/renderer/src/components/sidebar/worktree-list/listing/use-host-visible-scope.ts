import { useMemo } from 'react'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  filterProjectGroupsForFocus,
  getFocusedProjectGroupSubtreeIds,
  isMembershipInFocusedProjectGroup,
  resolveFocusedProjectGroupId
} from '../../../../../../shared/project-group-focus'
import type { SidebarWorktreeFilters } from './use-filters'
import { filterFolderWorkspacesFromOtherDevices } from '../../workspace-creator-visibility'
import {
  filterFolderWorkspacesForVisibleHosts,
  filterProjectGroupsForVisibleHosts,
  getVisibleSidebarHostIdSet
} from './host-filtering'

// Narrows repos, project groups, and folder workspaces to the hosts (and devices) the
// current host filter admits, then optionally to one focused client/group subtree.
export function useSidebarHostVisibleScope(args: {
  filterState: SidebarWorktreeFilters['filterState']
  defaultHostId: ExecutionHostId
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  pairedDeviceIdsByEnvironment: Parameters<typeof filterFolderWorkspacesFromOtherDevices>[1]
  focusedProjectGroupId?: string | null
}) {
  const { filterState, defaultHostId, repos, projectGroups, folderWorkspaces } = args
  const { visibleWorkspaceHostIds, workspaceHostScope, hideWorkspacesFromOtherDevices } =
    filterState
  const visibleHostIdSet = useMemo(
    () => getVisibleSidebarHostIdSet(visibleWorkspaceHostIds, workspaceHostScope),
    [visibleWorkspaceHostIds, workspaceHostScope]
  )
  const focusedSubtreeIds = useMemo(
    () => getFocusedProjectGroupSubtreeIds(projectGroups, args.focusedProjectGroupId),
    [args.focusedProjectGroupId, projectGroups]
  )
  const resolvedFocusedProjectGroupId = useMemo(
    () => resolveFocusedProjectGroupId(projectGroups, args.focusedProjectGroupId),
    [args.focusedProjectGroupId, projectGroups]
  )
  const visibleReposForRows = useMemo(() => {
    const hostVisible = !visibleHostIdSet
      ? repos
      : repos.filter((repo) => {
          const hostId =
            repo.connectionId || repo.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId
          return visibleHostIdSet.has(hostId)
        })
    if (!focusedSubtreeIds) {
      return hostVisible
    }
    return hostVisible.filter((repo) =>
      isMembershipInFocusedProjectGroup(repo.projectGroupId, focusedSubtreeIds)
    )
  }, [defaultHostId, focusedSubtreeIds, repos, visibleHostIdSet])
  const visibleProjectGroupsForRows = useMemo(() => {
    const hostVisible = filterProjectGroupsForVisibleHosts(
      projectGroups,
      visibleHostIdSet,
      defaultHostId
    )
    return filterProjectGroupsForFocus(hostVisible, focusedSubtreeIds)
  }, [defaultHostId, focusedSubtreeIds, projectGroups, visibleHostIdSet])
  const visibleFolderWorkspacesForRows = useMemo(() => {
    const hostVisibleWorkspaces = filterFolderWorkspacesForVisibleHosts(
      folderWorkspaces,
      projectGroups,
      visibleHostIdSet,
      defaultHostId
    )
    const deviceVisible = hideWorkspacesFromOtherDevices
      ? filterFolderWorkspacesFromOtherDevices(
          hostVisibleWorkspaces,
          args.pairedDeviceIdsByEnvironment
        )
      : hostVisibleWorkspaces
    if (!focusedSubtreeIds) {
      return deviceVisible
    }
    return deviceVisible.filter((workspace) =>
      isMembershipInFocusedProjectGroup(workspace.projectGroupId, focusedSubtreeIds)
    )
  }, [
    args.pairedDeviceIdsByEnvironment,
    defaultHostId,
    focusedSubtreeIds,
    folderWorkspaces,
    hideWorkspacesFromOtherDevices,
    projectGroups,
    visibleHostIdSet
  ])

  return {
    visibleReposForRows,
    visibleProjectGroupsForRows,
    visibleFolderWorkspacesForRows,
    focusedSubtreeIds,
    resolvedFocusedProjectGroupId
  }
}

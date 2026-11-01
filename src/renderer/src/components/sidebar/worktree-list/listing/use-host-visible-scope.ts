import { useMemo } from 'react'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { SidebarWorktreeFilters } from './use-filters'
import { filterFolderWorkspacesFromOtherDevices } from '../../../../../../shared/workspace-creator-visibility'
import {
  filterFolderWorkspacesForVisibleHosts,
  filterProjectGroupsForVisibleHosts,
  getVisibleSidebarHostIdSet
} from '../../../../../../shared/sidebar-list/host-filtering'
import { filterFolderWorkspacesForSelectedProjects } from '../../../../../../shared/sidebar-list/folder-workspace-project-visibility'

// Apply host/device scope consistently to repos, project groups and folder workspaces.
export function useSidebarHostVisibleScope(args: {
  filterState: SidebarWorktreeFilters['filterState']
  defaultHostId: ExecutionHostId
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  pairedDeviceIdsByEnvironment: Parameters<typeof filterFolderWorkspacesFromOtherDevices>[1]
}) {
  const { filterState, defaultHostId, repos, projectGroups, folderWorkspaces } = args
  const { visibleWorkspaceHostIds, workspaceHostScope, hideWorkspacesFromOtherDevices } =
    filterState
  const visibleHostIdSet = useMemo(
    () => getVisibleSidebarHostIdSet(visibleWorkspaceHostIds, workspaceHostScope),
    [visibleWorkspaceHostIds, workspaceHostScope]
  )
  const visibleReposForRows = useMemo(() => {
    if (!visibleHostIdSet) {
      return repos
    }
    return repos.filter((repo) => {
      const hostId =
        repo.connectionId || repo.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId
      return visibleHostIdSet.has(hostId)
    })
  }, [defaultHostId, repos, visibleHostIdSet])
  const visibleProjectGroupsForRows = useMemo(
    () => filterProjectGroupsForVisibleHosts(projectGroups, visibleHostIdSet, defaultHostId),
    [defaultHostId, projectGroups, visibleHostIdSet]
  )
  const visibleFolderWorkspacesForRows = useMemo(() => {
    const hostVisibleWorkspaces = filterFolderWorkspacesForVisibleHosts(
      folderWorkspaces,
      projectGroups,
      visibleHostIdSet,
      defaultHostId
    )
    const deviceVisibleWorkspaces = hideWorkspacesFromOtherDevices
      ? filterFolderWorkspacesFromOtherDevices(
          hostVisibleWorkspaces,
          args.pairedDeviceIdsByEnvironment
        )
      : hostVisibleWorkspaces
    return filterFolderWorkspacesForSelectedProjects(
      deviceVisibleWorkspaces,
      repos,
      filterState.filterRepoIds
    )
  }, [
    args.pairedDeviceIdsByEnvironment,
    defaultHostId,
    folderWorkspaces,
    hideWorkspacesFromOtherDevices,
    projectGroups,
    repos,
    filterState.filterRepoIds,
    visibleHostIdSet
  ])

  return { visibleReposForRows, visibleProjectGroupsForRows, visibleFolderWorkspacesForRows }
}

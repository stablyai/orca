import { useMemo } from 'react'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { SidebarWorktreeFilters } from './use-filters'
import type { filterFolderWorkspacesFromOtherDevices } from '../../../../../../shared/workspace-view/workspace-creator-visibility'
import { withoutBotListedFolderWorkspaces } from '../../../../../../shared/sidebar-list/selection/visible-worktrees'
import {
  filterProjectGroupsForVisibleHosts,
  getVisibleSidebarHostIdSet
} from '../../../../../../shared/sidebar-list/hosts/host-filtering'
import { filterFolderWorkspacesForSidebar } from '../../../../../../shared/sidebar-list/folders/folder-workspace-project-visibility'

// Apply host/device scope consistently to repos, project groups and folder workspaces.
export function useSidebarHostVisibleScope(args: {
  filterState: SidebarWorktreeFilters['filterState']
  defaultHostId: ExecutionHostId
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  pairedDeviceIdsByEnvironment: Parameters<typeof filterFolderWorkspacesFromOtherDevices>[1]
  /** Listed under their bot instead (compute-visible-worktrees.ts). */
  botListedWorktreeIdentities?: ReadonlySet<string>
}) {
  const { filterState, defaultHostId, repos, projectGroups, folderWorkspaces } = args
  const { visibleWorkspaceHostIds, workspaceHostScope } = filterState
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
  const visibleFolderWorkspacesForRows = useMemo(
    () =>
      filterFolderWorkspacesForSidebar(
        withoutBotListedFolderWorkspaces(folderWorkspaces, args.botListedWorktreeIdentities),
        projectGroups,
        visibleHostIdSet,
        defaultHostId,
        args.pairedDeviceIdsByEnvironment,
        repos,
        filterState
      ),
    [
      args.botListedWorktreeIdentities,
      args.pairedDeviceIdsByEnvironment,
      defaultHostId,
      folderWorkspaces,
      filterState,
      projectGroups,
      repos,
      visibleHostIdSet
    ]
  )

  return { visibleReposForRows, visibleProjectGroupsForRows, visibleFolderWorkspacesForRows }
}

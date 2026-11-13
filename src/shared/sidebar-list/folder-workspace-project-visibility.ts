import type { ExecutionHostId } from '../execution-host'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import { filterFolderWorkspacesFromOtherDevices } from '../workspace-creator-visibility'
import { filterFolderWorkspacesForVisibleHosts } from './host-filtering'

type FolderWorkspaceScopeFilters = {
  hideWorkspacesFromOtherDevices: boolean
  filterRepoIds: readonly string[]
}

/** Scope folder workspaces to visible hosts, this device, and the selected projects. */
export function filterFolderWorkspacesForSidebar(
  folderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  visibleHostIdSet: ReadonlySet<ExecutionHostId> | null,
  defaultHostId: ExecutionHostId,
  pairedDeviceIdsByEnvironment: Parameters<typeof filterFolderWorkspacesFromOtherDevices>[1],
  repos: readonly Repo[],
  filters: FolderWorkspaceScopeFilters
): readonly FolderWorkspace[] {
  const hostVisible = filterFolderWorkspacesForVisibleHosts(
    folderWorkspaces,
    projectGroups,
    visibleHostIdSet,
    defaultHostId
  )
  const deviceVisible = filters.hideWorkspacesFromOtherDevices
    ? filterFolderWorkspacesFromOtherDevices(hostVisible, pairedDeviceIdsByEnvironment)
    : hostVisible
  if (filters.filterRepoIds.length === 0) {
    return deviceVisible
  }
  const selectedRepoIds = new Set(filters.filterRepoIds)
  const selectedProjectGroupIds = new Set(
    repos.flatMap((repo) =>
      selectedRepoIds.has(repo.id) && repo.projectGroupId ? [repo.projectGroupId] : []
    )
  )
  return deviceVisible.filter((folderWorkspace) =>
    selectedProjectGroupIds.has(folderWorkspace.projectGroupId)
  )
}

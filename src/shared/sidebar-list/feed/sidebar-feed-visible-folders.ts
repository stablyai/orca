import type { ExecutionHostId } from '../../execution-host/execution-host'
import type { FolderWorkspace } from '../../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { Repo } from '../../repository/repo-types'
import { filterFolderWorkspacesFromOtherDevices } from '../../workspace-view/workspace-creator-visibility'
import { isDoneWorkspaceStatus } from '../../workspace/status/workspace-statuses'
import { filterFolderWorkspacesForVisibleHosts } from '../hosts/host-filtering'

export type DoneFolderScope = {
  folders: readonly FolderWorkspace[]
  /** Groups that had a visible folder before Hide Done removed it. */
  emptiedGroupIds: ReadonlySet<string>
}

export function scopeVisibleFolderWorkspacesByDone(
  visible: readonly FolderWorkspace[],
  hideDoneWorkspaces: boolean
): DoneFolderScope {
  if (!hideDoneWorkspaces) {
    return { folders: visible, emptiedGroupIds: new Set() }
  }
  const folders = visible.filter((folder) => !isDoneWorkspaceStatus(folder.workspaceStatus))
  const emptiedGroupIds = new Set<string>()
  for (const folder of visible) {
    if (!folders.includes(folder) && folder.projectGroupId) {
      emptiedGroupIds.add(folder.projectGroupId)
    }
  }
  return { folders, emptiedGroupIds }
}

/** Hide Done must not leave a project heading whose only visible content it removed. */
export function filterProjectGroupsWithVisibleContent(args: {
  groups: readonly ProjectGroup[]
  visibleRepos: readonly Pick<Repo, 'projectGroupId'>[]
  visibleFolders: readonly FolderWorkspace[]
  emptiedGroupIds: ReadonlySet<string>
}): readonly ProjectGroup[] {
  if (args.emptiedGroupIds.size === 0) {
    return args.groups
  }
  const groupById = new Map(args.groups.map((group) => [group.id, group]))
  const groupsWithVisibleContent = new Set<string>()
  const mark = (groupId: string | null | undefined): void => {
    let current = groupById.get(groupId ?? '')
    while (current) {
      groupsWithVisibleContent.add(current.id)
      current = current.parentGroupId ? groupById.get(current.parentGroupId) : undefined
    }
  }
  for (const repo of args.visibleRepos) {
    mark(repo.projectGroupId)
  }
  for (const folder of args.visibleFolders) {
    mark(folder.projectGroupId)
  }
  return args.groups.filter(
    (group) => !args.emptiedGroupIds.has(group.id) || groupsWithVisibleContent.has(group.id)
  )
}

export function sidebarFeedVisibleFolderScope(args: {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  visibleHostIdSet: ReadonlySet<ExecutionHostId> | null
  defaultHostId: ExecutionHostId
  hideWorkspacesFromOtherDevices: boolean
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  hideDoneWorkspaces: boolean
}): DoneFolderScope {
  const hostVisible = filterFolderWorkspacesForVisibleHosts(
    args.folderWorkspaces,
    args.projectGroups,
    args.visibleHostIdSet,
    args.defaultHostId
  )
  const deviceVisible = args.hideWorkspacesFromOtherDevices
    ? filterFolderWorkspacesFromOtherDevices(hostVisible, args.pairedDeviceIdsByEnvironment)
    : hostVisible
  return scopeVisibleFolderWorkspacesByDone(deviceVisible, args.hideDoneWorkspaces)
}

export function sidebarFeedVisibleFolderWorkspaces(args: {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  visibleHostIdSet: ReadonlySet<ExecutionHostId> | null
  defaultHostId: ExecutionHostId
  hideWorkspacesFromOtherDevices: boolean
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  hideDoneWorkspaces: boolean
}): readonly FolderWorkspace[] {
  return sidebarFeedVisibleFolderScope(args).folders
}

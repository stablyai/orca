import type { ExecutionHostId } from '../../execution-host/execution-host'
import type { FolderWorkspace } from '../../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import { filterFolderWorkspacesFromOtherDevices } from '../../workspace-view/workspace-creator-visibility'
import { isDoneWorkspaceStatus } from '../../workspace/status/workspace-statuses'
import { filterFolderWorkspacesForVisibleHosts } from '../hosts/host-filtering'

export function sidebarFeedVisibleFolderWorkspaces(args: {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  visibleHostIdSet: ReadonlySet<ExecutionHostId> | null
  defaultHostId: ExecutionHostId
  hideWorkspacesFromOtherDevices: boolean
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  hideDoneWorkspaces: boolean
}): readonly FolderWorkspace[] {
  const hostVisible = filterFolderWorkspacesForVisibleHosts(
    args.folderWorkspaces,
    args.projectGroups,
    args.visibleHostIdSet,
    args.defaultHostId
  )
  const deviceVisible = args.hideWorkspacesFromOtherDevices
    ? filterFolderWorkspacesFromOtherDevices(hostVisible, args.pairedDeviceIdsByEnvironment)
    : hostVisible
  return args.hideDoneWorkspaces
    ? deviceVisible.filter((folder) => !isDoneWorkspaceStatus(folder.workspaceStatus))
    : deviceVisible
}

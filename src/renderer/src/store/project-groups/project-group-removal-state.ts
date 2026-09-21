import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { catalogOwnsHost, getProjectGroupHostId } from '../slices/project-group-owner-routing'
import type { RepoSlice } from '../repos/repo-state'
import { getFolderWorkspaceHostId } from '../folder-workspaces/folder-workspace-catalog'

// Why: a group id can exist on several hosts; only the deleted owner's rows may be cascaded away.
export function applyProjectGroupDeleteCascade(
  state: Pick<RepoSlice, 'projectGroups' | 'folderWorkspaces' | 'repos'>,
  groupId: string,
  ownerHostId: ExecutionHostId | null
): Pick<RepoSlice, 'projectGroups' | 'folderWorkspaces' | 'repos' | 'folderWorkspacePathStatuses'> {
  const ownsRowHost = (rowHostId: string): boolean =>
    ownerHostId ? catalogOwnsHost(ownerHostId, rowHostId) : true
  const ownerGroups = state.projectGroups.filter((group) =>
    ownsRowHost(getProjectGroupHostId(group))
  )
  const deletedGroupIds = getProjectGroupSubtreeIds(ownerGroups, groupId)
  const isDeletedGroup = (group: ProjectGroup): boolean =>
    deletedGroupIds.has(group.id) && ownsRowHost(getProjectGroupHostId(group))
  return {
    projectGroups: state.projectGroups.filter((group) => !isDeletedGroup(group)),
    folderWorkspaces: state.folderWorkspaces.filter(
      (workspace) =>
        !deletedGroupIds.has(workspace.projectGroupId) ||
        // Why: resolve the workspace's host against the pre-delete group list, which still holds its owner row.
        !ownsRowHost(getFolderWorkspaceHostId(workspace, state.projectGroups))
    ),
    repos: state.repos.map((repo) =>
      repo.projectGroupId &&
      deletedGroupIds.has(repo.projectGroupId) &&
      ownsRowHost(getRepoExecutionHostId(repo))
        ? { ...repo, projectGroupId: null }
        : repo
    ),
    folderWorkspacePathStatuses: {}
  }
}

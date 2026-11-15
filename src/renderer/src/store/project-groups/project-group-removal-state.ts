import { projectGroupHookTrustKey } from '../../../../shared/workspace-hook-owner'
import type { AppState } from '../types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { catalogOwnsHost } from './project-group-owner-routing'
import type { RepoSlice } from '../repos/repo-state'
import '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspaces/folder-workspace-host-id'

// Why: a group id can exist on several hosts; only the deleted owner's rows may be cascaded away.
export function applyProjectGroupDeleteCascade(
  state: Pick<RepoSlice, 'projectGroups' | 'folderWorkspaces' | 'repos'> &
    Partial<Pick<AppState, 'trustedOrcaHooks'>>,
  groupId: string,
  ownerHostId: ExecutionHostId | null
): Pick<RepoSlice, 'projectGroups' | 'folderWorkspaces' | 'repos' | 'folderWorkspacePathStatuses'> &
  Partial<Pick<AppState, 'trustedOrcaHooks'>> {
  const ownsRowHost = (rowHostId: string): boolean =>
    ownerHostId ? catalogOwnsHost(ownerHostId, rowHostId) : true
  const ownerGroups = state.projectGroups.filter((group) =>
    ownsRowHost(getRepoExecutionHostId(group))
  )
  const deletedGroupIds = getProjectGroupSubtreeIds(ownerGroups, groupId)
  const isDeletedGroup = (group: ProjectGroup): boolean =>
    deletedGroupIds.has(group.id) && ownsRowHost(getRepoExecutionHostId(group))
  const removedTrustKeys = new Set(
    state.projectGroups.filter(isDeletedGroup).map(projectGroupHookTrustKey)
  )
  return {
    ...(state.trustedOrcaHooks
      ? {
          trustedOrcaHooks: Object.fromEntries(
            Object.entries(state.trustedOrcaHooks).filter(([key]) => !removedTrustKeys.has(key))
          )
        }
      : {}),
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

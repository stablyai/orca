import { editSessionSource } from '@/store/session-source-edits'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { catalogOwnsHost, getProjectGroupHostId } from '../slices/project-group-owner-routing'
import type { AppState } from '../types'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'

// Why: a group id can exist on several hosts; only the deleted owner's rows may be cascaded away.
export function applyProjectGroupDeleteCascade(
  state: AppState,
  groupId: string,
  ownerHostId: ExecutionHostId | null
) {
  const ownsRowHost = (rowHostId: string): boolean =>
    ownerHostId ? catalogOwnsHost(ownerHostId, rowHostId) : true
  const ownerGroups = state.projectGroups.filter((group) =>
    ownsRowHost(getProjectGroupHostId(group))
  )
  const deletedGroupIds = getProjectGroupSubtreeIds(ownerGroups, groupId)
  const isDeletedGroup = (group: ProjectGroup): boolean =>
    deletedGroupIds.has(group.id) && ownsRowHost(getProjectGroupHostId(group))
  const edit = editSessionSource(state)
  edit.sequence('projectGroups').filter((group) => !isDeletedGroup(group))
  edit.sequence('folderWorkspaces').filter(
    (workspace) =>
      !deletedGroupIds.has(workspace.projectGroupId) ||
      // Why: resolve the workspace's host against the pre-delete group list, which still holds its owner row.
      !ownsRowHost(getFolderWorkspaceHostId(workspace, state.projectGroups))
  )
  edit
    .sequence('repos')
    .map((repo) =>
      repo.projectGroupId &&
      deletedGroupIds.has(repo.projectGroupId) &&
      ownsRowHost(getRepoExecutionHostId(repo))
        ? { ...repo, projectGroupId: null }
        : repo
    )
  return edit.finish({ folderWorkspacePathStatuses: {} })
}

import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getFolderWorkspaceExecutionHostIdForRows } from './worktree-list/listing/host-filtering'

/**
 * Which host section a folder workspace's row belongs to.
 *
 * Header counting, host bucketing and reveal all resolve the host through here
 * (#15362). This matches the visibility filter: a connectionless runtime stamp
 * is the group's host, not whichever server happens to be focused (#13944).
 */
export function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return getFolderWorkspaceExecutionHostIdForRows({
    folderWorkspace,
    projectGroup,
    defaultHostId
  })
}

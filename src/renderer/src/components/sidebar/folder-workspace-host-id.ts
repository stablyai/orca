import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getFolderWorkspaceExecutionHostIdForRows } from './worktree-list/listing/host-filtering'

/** Host headers, filtering and reveal must agree on the folder's execution owner. */
export function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return getFolderWorkspaceExecutionHostIdForRows({ folderWorkspace, projectGroup, defaultHostId })
}

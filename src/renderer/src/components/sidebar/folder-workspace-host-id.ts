import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getFolderWorkspaceExecutionHostIdForRows } from './worktree-list/listing/host-filtering'

/** Keep host bucketing, lane counts and reveal aligned with host filtering. */
export function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  return getFolderWorkspaceExecutionHostIdForRows({ folderWorkspace, projectGroup, defaultHostId })
}

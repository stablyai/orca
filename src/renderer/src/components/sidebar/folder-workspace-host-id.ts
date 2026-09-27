import {
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

// Preserve legacy folder-over-group connection ownership after explicit host pins.
export function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'> | undefined,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  const explicitHostId =
    normalizeExecutionHostId(folderWorkspace.executionHostId) ??
    normalizeExecutionHostId(projectGroup?.executionHostId)
  if (explicitHostId) {
    return explicitHostId
  }
  const connectionId = folderWorkspace.connectionId ?? projectGroup?.connectionId
  return connectionId ? toSshExecutionHostId(connectionId) : defaultHostId
}

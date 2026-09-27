import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { FolderWorkspaceRow } from '../grouping/row-types'
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'

export function resolveFolderRowHost(
  row: FolderWorkspaceRow,
  defaultHostId: ExecutionHostId = 'local'
): FolderWorkspaceRow {
  const executionHostId = getFolderWorkspaceHostId(
    row.folderWorkspace,
    row.projectGroup,
    defaultHostId
  )
  return row.folderWorkspace.executionHostId === executionHostId
    ? row
    : { ...row, folderWorkspace: { ...row.folderWorkspace, executionHostId } }
}

export function getFolderRowKey(row: FolderWorkspaceRow): string {
  return getWorktreeHostIdentity({
    id: folderWorkspaceKey(row.folderWorkspace.id),
    hostId: getFolderWorkspaceHostId(row.folderWorkspace, row.projectGroup, 'local')
  })
}

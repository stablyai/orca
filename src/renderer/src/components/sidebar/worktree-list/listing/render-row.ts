import type { HostSectionRow } from '../../host-section-rows'
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

type WorktreeItemRow = Extract<HostSectionRow, { type: 'item' }>
export type RenderRow =
  | HostSectionRow
  | { type: 'lineage-group'; key: string; rows: WorktreeItemRow[] }

export function getFolderWorkspaceSidebarRowKey(
  row: Extract<HostSectionRow, { type: 'folder-workspace' }>,
  defaultHostId: ExecutionHostId
): string {
  return composeWorktreeHostIdentity(
    getFolderWorkspaceHostId(row.folderWorkspace, row.projectGroup, defaultHostId),
    folderWorkspaceKey(row.folderWorkspace.id)
  )
}

export function getRenderRowKey(
  row: RenderRow,
  defaultHostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): string {
  if (row.type === 'host-header') {
    return `host:${row.hostId}`
  }
  if (row.type === 'header') {
    return row.hostId ? `hdr:${row.hostId}:${row.key}` : `hdr:${row.key}`
  }
  if (row.type === 'lineage-group') {
    return `lineage-group:${row.key}`
  }
  if (row.type === 'imported-worktrees-card') {
    return `imported:${row.key}`
  }
  if (row.type === 'new-external-worktrees-inbox') {
    return `inbox:${row.key}`
  }
  if (row.type === 'pending-creation') {
    return `pending:${row.creationId}`
  }
  if (row.type === 'folder-workspace') {
    return `folder-workspace:${getFolderWorkspaceSidebarRowKey(row, defaultHostId)}`
  }
  return `wt:${row.rowKey}`
}

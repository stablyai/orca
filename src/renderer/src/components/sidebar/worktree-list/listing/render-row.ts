import type { HostSectionRow } from '../../host-section-rows'

type WorktreeItemRow = Extract<HostSectionRow, { type: 'item' }>
export type RenderRow =
  | HostSectionRow
  | { type: 'lineage-group'; key: string; rows: WorktreeItemRow[] }

export function getRenderRowKey(row: RenderRow): string {
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
    return `folder-workspace:${row.folderWorkspace.id}`
  }
  return `wt:${row.rowKey}`
}

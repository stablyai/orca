import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'

type WorktreeItemRow = Extract<HostSectionRow, { type: 'item' }>
type FolderWorkspaceItemRow = Extract<HostSectionRow, { type: 'folder-workspace' }>
export type RenderRow =
  | HostSectionRow
  /** A parent card with its visible descendants. With `folder`, the folder is the parent and `rows`
   * are only its descendants; otherwise `rows[0]` is the parent. */
  | { type: 'lineage-group'; key: string; rows: WorktreeItemRow[]; folder?: FolderWorkspaceItemRow }

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
    return row.key
  }
  return `wt:${row.rowKey}`
}

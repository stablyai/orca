import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'

export type RenderRow = HostSectionRow

export function getRenderRowKey(row: RenderRow): string {
  if (row.type === 'host-header') {
    return `host:${row.hostId}`
  }
  if (row.type === 'header') {
    return row.hostId ? `hdr:${row.hostId}:${row.key}` : `hdr:${row.key}`
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

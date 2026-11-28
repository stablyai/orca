import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'

export function hasRenderedSidebarRowKey(
  sectionRows: readonly HostSectionRow[],
  rowKey: string
): boolean {
  for (let i = 0; i < sectionRows.length; i += 1) {
    const row = sectionRows[i]
    if (row.type === 'header') {
      if (row.key === rowKey) {
        return true
      }
    } else if (row.type === 'item') {
      if (row.rowKey === rowKey) {
        return true
      }
    } else if (row.type === 'folder-workspace') {
      if (
        getFolderWorkspaceHostIdentity(row.folderWorkspace) === rowKey ||
        folderWorkspaceKey(row.folderWorkspace.id) === rowKey
      ) {
        return true
      }
    } else if (row.type === 'pending-creation') {
      if (`pending:${row.creationId}` === rowKey) {
        return true
      }
    } else if (
      (row.type === 'imported-worktrees-card' || row.type === 'new-external-worktrees-inbox') &&
      row.key === rowKey
    ) {
      return true
    }
  }
  return false
}

export function collectRenderedSidebarRowKeys(sectionRows: readonly HostSectionRow[]): Set<string> {
  const keys = new Set<string>()
  for (const row of sectionRows) {
    if (row.type === 'header') {
      keys.add(row.key)
    } else if (row.type === 'item') {
      keys.add(row.rowKey)
    } else if (row.type === 'folder-workspace') {
      keys.add(getFolderWorkspaceHostIdentity(row.folderWorkspace))
      keys.add(folderWorkspaceKey(row.folderWorkspace.id))
    } else if (row.type === 'pending-creation') {
      keys.add(`pending:${row.creationId}`)
    } else if (row.type === 'imported-worktrees-card') {
      keys.add(row.key)
    } else if (row.type === 'new-external-worktrees-inbox') {
      keys.add(row.key)
    }
  }
  return keys
}

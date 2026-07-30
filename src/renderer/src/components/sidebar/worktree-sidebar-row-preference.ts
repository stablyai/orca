import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/types'
import type { HostSectionRow } from './host-section-rows'
import {
  PINNED_GROUP_KEY,
  type PinnedWorktreeDisplayPolicy,
  type WorktreeRow
} from './worktree-list-groups'

export function getPreferredWorktreeRows(
  rows: readonly WorktreeRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): WorktreeRow[] {
  // Why: duplicated pinned rows represent one workspace to navigation and selection.
  // Prefer its natural-group copy, falling back to Pinned when that copy is hidden.
  if (pinnedDisplayPolicy === 'single-location') {
    const seen = new Set<string>()
    return rows.filter((row) => {
      if (seen.has(row.worktree.id)) {
        return false
      }
      seen.add(row.worktree.id)
      return true
    })
  }

  const preferredRows: WorktreeRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.sectionKey === PINNED_GROUP_KEY || seen.has(row.worktree.id)) {
      continue
    }
    preferredRows.push(row)
    seen.add(row.worktree.id)
  }
  for (const row of rows) {
    if (seen.has(row.worktree.id)) {
      continue
    }
    preferredRows.push(row)
    seen.add(row.worktree.id)
  }
  return preferredRows
}

export function getRenderedWorktreesInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Worktree[] {
  const itemRows = rows.filter((row): row is WorktreeRow => row.type === 'item')
  const preferredRowKeys = new Set(
    getPreferredWorktreeRows(itemRows, pinnedDisplayPolicy).map((row) => row.rowKey)
  )
  const renderedWorktrees: Worktree[] = []

  for (const row of rows) {
    if (row.type === 'item' && preferredRowKeys.has(row.rowKey)) {
      renderedWorktrees.push(row.worktree)
    } else if (row.type === 'folder-workspace') {
      renderedWorktrees.push(folderWorkspaceToWorktree(row.folderWorkspace))
    }
  }
  return renderedWorktrees
}

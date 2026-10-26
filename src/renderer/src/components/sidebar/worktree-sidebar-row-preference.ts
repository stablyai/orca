import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../shared/sidebar-list/host-section-rows'
import { PINNED_GROUP_KEY } from '../../../../shared/sidebar-list/group-keys'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeRow
} from '../../../../shared/sidebar-list/row-types'

export function getPreferredWorktreeRows(
  rows: readonly WorktreeRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): WorktreeRow[] {
  // Navigation/selection treat pinned duplicates as one workspace, preferring a visible natural-group occurrence.
  if (pinnedDisplayPolicy === 'single-location') {
    const seen = new Set<string>()
    return rows.filter((row) => {
      const identity = getWorktreeHostIdentity(row.worktree)
      if (seen.has(identity)) {
        return false
      }
      seen.add(identity)
      return true
    })
  }

  const preferredRows: WorktreeRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const identity = getWorktreeHostIdentity(row.worktree)
    if (row.sectionKey === PINNED_GROUP_KEY || seen.has(identity)) {
      continue
    }
    preferredRows.push(row)
    seen.add(identity)
  }
  for (const row of rows) {
    const identity = getWorktreeHostIdentity(row.worktree)
    if (seen.has(identity)) {
      continue
    }
    preferredRows.push(row)
    seen.add(identity)
  }
  return preferredRows
}

export type RenderedWorkspaceRow = Pick<WorktreeRow, 'worktree' | 'repo'>

export function getRenderedWorkspaceRowsInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): RenderedWorkspaceRow[] {
  const itemRows = rows.filter((row): row is WorktreeRow => row.type === 'item')
  const preferredRowKeys = new Set(
    getPreferredWorktreeRows(itemRows, pinnedDisplayPolicy).map((row) => row.rowKey)
  )
  const renderedRows: RenderedWorkspaceRow[] = []

  for (const row of rows) {
    if (row.type === 'item' && preferredRowKeys.has(row.rowKey)) {
      renderedRows.push({ worktree: row.worktree, repo: row.repo })
    } else if (row.type === 'folder-workspace') {
      renderedRows.push({
        worktree: folderWorkspaceToWorktree(row.folderWorkspace),
        repo: undefined
      })
    }
  }
  return renderedRows
}

export function getRenderedWorktreesInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Worktree[] {
  return getRenderedWorkspaceRowsInSidebarOrder(rows, pinnedDisplayPolicy).map(
    (row) => row.worktree
  )
}

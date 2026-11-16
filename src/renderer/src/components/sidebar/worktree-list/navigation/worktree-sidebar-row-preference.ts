import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeRow
} from '../../../../../../shared/sidebar-list/row-types'
import {
  getWorkspaceItemRowKey,
  getWorkspaceItemRowWorktree,
  isWorkspaceItemRow
} from '../listing/renderable-rows'

export function getPreferredWorktreeRows<Row extends { worktree: Worktree; sectionKey?: string }>(
  rows: readonly Row[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Row[] {
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

  const preferredRows: Row[] = []
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

export type RenderedWorkspaceRow = Pick<WorktreeRow, 'worktree' | 'repo' | 'rowKey'>

export function getRenderedWorkspaceRowsInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): RenderedWorkspaceRow[] {
  const itemRows = rows.filter(isWorkspaceItemRow).map((row) => ({
    worktree: getWorkspaceItemRowWorktree(row),
    repo: row.type === 'item' ? row.repo : undefined,
    rowKey: getWorkspaceItemRowKey(row),
    sectionKey: row.sectionKey
  }))
  const preferredRowKeys = new Set(
    getPreferredWorktreeRows(itemRows, pinnedDisplayPolicy).map((row) => row.rowKey)
  )
  return itemRows.filter((row) => preferredRowKeys.has(row.rowKey))
}

export function getRenderedWorktreesInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Worktree[] {
  return getRenderedWorkspaceRowsInSidebarOrder(rows, pinnedDisplayPolicy).map(
    (row) => row.worktree
  )
}

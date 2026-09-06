import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from './host-section-rows'
import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import type { FolderWorkspaceItemRow } from './worktree-list/listing/renderable-rows'
import type { PinnedWorktreeDisplayPolicy, WorktreeRow } from './worktree-list/grouping/row-types'

/**
 * One row per workspace, out of the copies the sidebar rendered.
 *
 * Why: a duplicated pinned row is the same workspace to navigation and
 * selection. Prefer its natural-group copy, falling back to the Pinned copy
 * when that is the only one rendered.
 */
function getPreferredRows<Row>(
  rows: readonly Row[],
  getIdentity: (row: Row) => string,
  isPinnedSectionRow: (row: Row) => boolean
): Row[] {
  const preferredRows: Row[] = []
  const seen = new Set<string>()
  const take = (row: Row): void => {
    preferredRows.push(row)
    seen.add(getIdentity(row))
  }
  for (const row of rows) {
    if (!isPinnedSectionRow(row) && !seen.has(getIdentity(row))) {
      take(row)
    }
  }
  for (const row of rows) {
    if (!seen.has(getIdentity(row))) {
      take(row)
    }
  }
  return preferredRows
}

export function getPreferredWorktreeRows(
  rows: readonly WorktreeRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): WorktreeRow[] {
  return getPreferredRows(
    rows,
    (row) => getWorktreeHostIdentity(row.worktree),
    (row) => pinnedDisplayPolicy === 'duplicate-in-groups' && row.sectionKey === PINNED_GROUP_KEY
  )
}

export function getRenderedWorktreesInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Worktree[] {
  const preferredRowKeys = new Set([
    ...getPreferredWorktreeRows(
      rows.filter((row): row is WorktreeRow => row.type === 'item'),
      pinnedDisplayPolicy
    ).map((row) => row.rowKey),
    ...getPreferredRows(
      rows.filter((row): row is FolderWorkspaceItemRow => row.type === 'folder-workspace'),
      (row) => row.folderWorkspace.id,
      (row) => pinnedDisplayPolicy === 'duplicate-in-groups' && row.sectionKey === PINNED_GROUP_KEY
    ).map((row) => row.key)
  ])

  const renderedWorktrees: Worktree[] = []
  for (const row of rows) {
    if (row.type === 'item' && preferredRowKeys.has(row.rowKey)) {
      renderedWorktrees.push(row.worktree)
    } else if (row.type === 'folder-workspace' && preferredRowKeys.has(row.key)) {
      renderedWorktrees.push(folderWorkspaceToWorktree(row.folderWorkspace))
    }
  }
  return renderedWorktrees
}

import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from './host-section-rows'
import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import type { PinnedWorktreeDisplayPolicy, WorktreeRow } from './worktree-list/grouping/row-types'

export function getPreferredWorktreeRows(
  rows: readonly WorktreeRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): WorktreeRow[] {
  // Why: duplicated pinned rows represent one workspace to navigation and selection.
  // Prefer its natural-group copy, falling back to Pinned when that copy is hidden.
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

export function getRenderedWorktreesInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Worktree[] {
  const itemRows = rows.filter((row): row is WorktreeRow => row.type === 'item')
  const preferredRowKeys = new Set(
    getPreferredWorktreeRows(itemRows, pinnedDisplayPolicy).map((row) => row.rowKey)
  )
  const renderedWorktrees: Worktree[] = []
  const seenFolderIds = new Set<string>()
  const naturalFolderIds = new Set(
    rows
      .filter(
        (row): row is Extract<HostSectionRow, { type: 'folder-workspace' }> =>
          row.type === 'folder-workspace' && row.sectionKey !== PINNED_GROUP_KEY
      )
      .map((row) => row.folderWorkspace.id)
  )

  for (const row of rows) {
    if (row.type === 'item' && preferredRowKeys.has(row.rowKey)) {
      renderedWorktrees.push(row.worktree)
    } else if (row.type === 'folder-workspace') {
      const folderId = row.folderWorkspace.id
      if (seenFolderIds.has(folderId)) {
        continue
      }
      if (
        pinnedDisplayPolicy === 'duplicate-in-groups' &&
        row.sectionKey === PINNED_GROUP_KEY &&
        naturalFolderIds.has(folderId)
      ) {
        continue
      }
      seenFolderIds.add(folderId)
      renderedWorktrees.push(folderWorkspaceToWorktree(row.folderWorkspace))
    }
  }
  return renderedWorktrees
}

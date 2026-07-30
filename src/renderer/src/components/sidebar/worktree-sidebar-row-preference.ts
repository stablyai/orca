import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
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

export function isWorkspaceRowIdentityRendered(
  rows: readonly HostSectionRow[],
  identity: { worktreeId: string; rowKey: string }
): boolean {
  return rows.some((row) => {
    if (row.type === 'item') {
      return row.worktree.id === identity.worktreeId && row.rowKey === identity.rowKey
    }
    return (
      row.type === 'folder-workspace' &&
      folderWorkspaceKey(row.folderWorkspace.id) === identity.worktreeId &&
      row.key === identity.rowKey
    )
  })
}

export function getRenderedWorktreesInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Worktree[] {
  const itemRows = rows.filter((row): row is WorktreeRow => row.type === 'item')
  const preferredRowKeys = new Set(
    getPreferredWorktreeRows(itemRows, pinnedDisplayPolicy).map((row) => row.rowKey)
  )
  // Why: duplicate-in-groups renders a pinned folder workspace twice; prefer
  // the natural-lane copy so numbering matches worktree preference rules.
  const folderIdsWithNaturalCopy = new Set<string>()
  for (const row of rows) {
    if (row.type === 'folder-workspace' && row.sectionKey !== PINNED_GROUP_KEY) {
      folderIdsWithNaturalCopy.add(row.folderWorkspace.id)
    }
  }
  const seenFolderIds = new Set<string>()
  const renderedWorktrees: Worktree[] = []

  for (const row of rows) {
    if (row.type === 'item' && preferredRowKeys.has(row.rowKey)) {
      renderedWorktrees.push(row.worktree)
    } else if (row.type === 'folder-workspace') {
      const isPinnedCopy = row.sectionKey === PINNED_GROUP_KEY
      if (seenFolderIds.has(row.folderWorkspace.id)) {
        continue
      }
      if (isPinnedCopy && folderIdsWithNaturalCopy.has(row.folderWorkspace.id)) {
        continue
      }
      seenFolderIds.add(row.folderWorkspace.id)
      renderedWorktrees.push(folderWorkspaceToWorktree(row.folderWorkspace))
    }
  }
  return renderedWorktrees
}

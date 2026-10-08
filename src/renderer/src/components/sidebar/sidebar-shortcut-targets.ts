import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import type { HostSectionRow } from './host-section-rows'
import type { PinnedWorktreeDisplayPolicy, WorktreeRow } from './worktree-list/grouping/row-types'
import { getPreferredWorktreeRows } from './worktree-sidebar-row-preference'

/** One Cmd+1–9 slot. A folded compact project is one slot, resolved to a workspace on press. */
export type SidebarShortcutTarget = {
  id: string
  executionHostId?: Worktree['hostId']
  lineageGroupKey?: string
  projectWorktreeIds?: readonly string[]
}

function toWorktreeTarget(worktree: Worktree, lineageGroupKey?: string): SidebarShortcutTarget {
  return {
    id: worktree.id,
    ...(worktree.hostId ? { executionHostId: worktree.hostId } : {}),
    ...(lineageGroupKey ? { lineageGroupKey } : {})
  }
}

// Why projects, not cards, in compact mode: numbering only the visible project rows keeps each
// project's digit stable while the accordion opens and folds cards under the active one.
export function getSidebarShortcutTargets(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): SidebarShortcutTarget[] {
  const itemRows = rows.filter((row): row is WorktreeRow => row.type === 'item')
  const preferredRowKeys = new Set(
    getPreferredWorktreeRows(itemRows, pinnedDisplayPolicy).map((row) => row.rowKey)
  )
  const targets: SidebarShortcutTarget[] = []
  for (const row of rows) {
    if (row.type === 'header') {
      const ids = row.projectWorktreeIds
      if (row.compactProjectActive !== undefined && ids && ids.length > 0) {
        targets.push({ id: ids[0]!, projectWorktreeIds: ids })
      }
    } else if (row.type === 'item') {
      if (!row.inExpandedCompactProject && preferredRowKeys.has(row.rowKey)) {
        const chipKey = row.lineageChildCount > 0 ? row.lineageGroupKey : undefined
        targets.push(toWorktreeTarget(row.worktree, chipKey))
      }
    } else if (row.type === 'folder-workspace') {
      targets.push(toWorktreeTarget(folderWorkspaceToWorktree(row.folderWorkspace)))
    }
  }
  return targets
}

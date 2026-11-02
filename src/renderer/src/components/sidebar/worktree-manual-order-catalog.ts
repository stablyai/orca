import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  buildWorktreeSortLabels,
  compareWorktreeSortLabel
} from '../../../../shared/sidebar-list/smart-sort'

/** Manual ranks by host identity: same-id copies on two hosts are separate cards. */
export type WorktreeManualOrderCatalog = {
  orderedKeys: readonly string[]
  rankByKey: ReadonlyMap<string, number>
}

export function buildWorktreeManualOrderCatalog(args: {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
}): WorktreeManualOrderCatalog {
  const rows = [
    ...args.worktrees,
    ...args.folderWorkspaces.map((workspace) => folderWorkspaceToWorktree(workspace))
  ].filter((row) => !row.isArchived)
  const labels = buildWorktreeSortLabels(rows)
  rows.sort(
    (left, right) =>
      (right.manualOrder ?? right.sortOrder) - (left.manualOrder ?? left.sortOrder) ||
      compareWorktreeSortLabel(left, right, labels)
  )
  const rowsByKey = new Map<string, Worktree[]>()
  for (const row of rows) {
    const key = getWorktreeHostIdentity(row)
    const matches = rowsByKey.get(key)
    if (matches) {
      matches.push(row)
    } else {
      rowsByKey.set(key, [row])
    }
  }

  const orderedKeys = [...rowsByKey.keys()]
  const rankByKey = new Map<string, number>()
  for (const [key, matches] of rowsByKey) {
    const ranks = matches.map((row) => row.manualOrder)
    const rank = ranks[0]
    if (
      typeof rank === 'number' &&
      Number.isFinite(rank) &&
      ranks.every((candidate) => candidate === rank)
    ) {
      rankByKey.set(key, rank)
    }
  }
  return { orderedKeys, rankByKey }
}

import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import { compareWorktreeSortLabel } from './smart-sort'

export type WorktreeManualOrderCatalog = {
  orderedIds: readonly string[]
  rankByWorktreeId: ReadonlyMap<string, number>
}

export function buildWorktreeManualOrderCatalog(args: {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
}): WorktreeManualOrderCatalog {
  const rows = [
    ...args.worktrees,
    ...args.folderWorkspaces.map((workspace) => folderWorkspaceToWorktree(workspace))
  ]
    .filter((row) => !row.isArchived)
    .sort(
      (left, right) =>
        (right.manualOrder ?? right.sortOrder) - (left.manualOrder ?? left.sortOrder) ||
        compareWorktreeSortLabel(left, right)
    )
  const rowsById = new Map<string, Worktree[]>()
  for (const row of rows) {
    const matches = rowsById.get(row.id)
    if (matches) {
      matches.push(row)
    } else {
      rowsById.set(row.id, [row])
    }
  }

  const orderedIds = [...rowsById.keys()]
  const rankByWorktreeId = new Map<string, number>()
  for (const [worktreeId, matches] of rowsById) {
    const ranks = matches.map((row) => row.manualOrder)
    const rank = ranks[0]
    if (
      typeof rank === 'number' &&
      Number.isFinite(rank) &&
      ranks.every((candidate) => candidate === rank)
    ) {
      rankByWorktreeId.set(worktreeId, rank)
    }
  }
  return { orderedIds, rankByWorktreeId }
}

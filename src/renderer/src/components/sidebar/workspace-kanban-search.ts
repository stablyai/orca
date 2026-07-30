import { isWorktreePaletteQueryTooLarge } from '@/lib/worktree-palette-query-bounds'
import { searchWorktrees, type PaletteMatchedField } from '@/lib/worktree-palette-search'
import type { Repo, WorkspaceStatus, Worktree } from '../../../../shared/types'

export type WorkspaceKanbanLaneView = {
  items: readonly Worktree[]
  totalCount: number
}

// Why: the board is a drag surface for named workspaces, so a card may only be
// hidden by fields the user can read on it. PR/issue/port matches are palette-only.
const BOARD_MATCHED_FIELDS: ReadonlySet<PaletteMatchedField> = new Set<PaletteMatchedField>([
  'displayName',
  'branch',
  'repo',
  'comment'
])

/**
 * Returns `null` when no filtering is active — distinct from an empty set, which
 * means a real query matched nothing.
 */
export function matchWorkspaceBoardWorktrees(args: {
  worktrees: Worktree[]
  query: string
  repoMap: Map<string, Repo>
}): ReadonlySet<string> | null {
  if (!args.query.trim()) {
    return null
  }
  // Why: searchWorktrees returns [] for an over-bound query, which downstream
  // reads as "matched nothing" and blanks the whole board on a paste accident.
  if (isWorktreePaletteQueryTooLarge(args.query)) {
    return null
  }

  const matched = new Set<string>()
  for (const result of searchWorktrees(args.worktrees, args.query, args.repoMap, null, null)) {
    if (result.matchedField && BOARD_MATCHED_FIELDS.has(result.matchedField)) {
      matched.add(result.worktreeId)
    }
  }
  return matched
}

export function buildWorkspaceKanbanLaneViews(args: {
  worktreesByStatus: ReadonlyMap<WorkspaceStatus, readonly Worktree[]>
  matchingWorktreeIds: ReadonlySet<string> | null
}): Map<WorkspaceStatus, WorkspaceKanbanLaneView> {
  const matchingWorktreeIds = args.matchingWorktreeIds
  const views = new Map<WorkspaceStatus, WorkspaceKanbanLaneView>()
  for (const [status, items] of args.worktreesByStatus) {
    views.set(status, {
      // Why: the no-query path must not reallocate a lane array per keystroke.
      items: matchingWorktreeIds
        ? items.filter((worktree) => matchingWorktreeIds.has(worktree.id))
        : items,
      totalCount: items.length
    })
  }
  return views
}

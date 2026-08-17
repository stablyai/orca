import { isWorktreePaletteQueryTooLarge } from '@/lib/worktree-palette-query-bounds'
import { searchWorktrees } from '@/lib/worktree-palette-search'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatus, Worktree } from '../../../../shared/worktree/types'

export type WorkspaceKanbanLaneView = {
  items: readonly Worktree[]
  totalCount: number
}

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
  // Why the board policy: a card may only be hidden by text printed on it, so
  // palette-only evidence such as ports, reviews, and automation runs is excluded.
  for (const result of searchWorktrees(args.worktrees, args.query, args.repoMap, {
    evidencePolicy: 'board'
  })) {
    if (result.matchedFields.length) {
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

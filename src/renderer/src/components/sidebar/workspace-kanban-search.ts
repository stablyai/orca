import { isWorktreePaletteQueryTooLarge } from '@/lib/worktree-palette-query-bounds'
import { searchWorktrees } from '@/lib/worktree-palette-search'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatus, Worktree } from '../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'

export type WorkspaceKanbanLaneView = {
  items: readonly Worktree[]
  totalCount: number
}

// Why: the board is a drag surface for named workspaces, so a card may only be
// hidden by fields the user can read on it. PR/issue/port matches are palette-only.
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
  // Why the board policy (#15170): a card may only be hidden by text printed on it, so
  // palette-only evidence such as ports, reviews and automation runs is excluded.
  for (const result of searchWorktrees(args.worktrees, args.query, args.repoMap, {
    evidencePolicy: 'board'
  })) {
    if (result.matchedFields.length) {
      // Why (STA-4343): two hosts can publish the same id, and a board filter keyed on the
      // bare id would show or hide both hosts' cards together.
      matched.add(composeWorktreeHostIdentity(result.worktreeHostId, result.worktreeId))
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
        ? items.filter((worktree) => matchingWorktreeIds.has(getWorktreeHostIdentity(worktree)))
        : items,
      totalCount: items.length
    })
  }
  return views
}

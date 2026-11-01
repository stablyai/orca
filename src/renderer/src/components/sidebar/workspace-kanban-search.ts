import { isWorktreePaletteQueryTooLarge } from '../../../../shared/palette-match/worktree-palette-query-bounds'
import { searchWorktreeDocuments } from '@/lib/worktree-palette-search'
import { buildWorktreePaletteDocuments } from '@/lib/worktree-palette-document'
import type { PaletteDocument } from '../../../../shared/palette-match/palette-document'
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

/** Reuse normalized search documents across keystrokes and agent-status ticks. */
export function buildWorkspaceBoardPaletteDocuments(args: {
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
}): Map<string, PaletteDocument> {
  // Board search may hide cards only by printed text; ports, reviews and automation remain palette-only.
  return buildWorktreePaletteDocuments(args.worktrees, {
    repoMap: args.repoMap,
    evidencePolicy: 'board'
  })
}

/** Null means no active filter; an empty set means the query matched nothing. */
export function matchWorkspaceBoardWorktrees(args: {
  worktrees: Worktree[]
  query: string
  repoMap: Map<string, Repo>
  documents?: ReadonlyMap<string, PaletteDocument>
}): ReadonlySet<string> | null {
  if (!args.query.trim()) {
    return null
  }
  // Ignore oversized queries so an accidental paste cannot blank the board.
  if (isWorktreePaletteQueryTooLarge(args.query)) {
    return null
  }

  const matched = new Set<string>()
  const documents =
    args.documents ??
    buildWorkspaceBoardPaletteDocuments({ worktrees: args.worktrees, repoMap: args.repoMap })
  for (const result of searchWorktreeDocuments({
    worktrees: args.worktrees,
    query: args.query,
    documents,
    repoMap: args.repoMap
  })) {
    if (result.matchedFields.length) {
      // Qualify matches by host so same-ID cards remain independently searchable.
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
      // Keep the no-query lane array stable across keystrokes.
      items: matchingWorktreeIds
        ? items.filter((worktree) => matchingWorktreeIds.has(getWorktreeHostIdentity(worktree)))
        : items,
      totalCount: items.length
    })
  }
  return views
}

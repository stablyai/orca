import type { Repo } from '../repo-types'
import { isFolderRepo } from '../repo-kind'
import type { PRGroupKey } from '../sidebar-list/group-keys'
import type { Worktree } from '../worktree/types'

/** What list rules read about a workspace: cheap row facts the list already holds, so arranging
 *  300 rows never subscribes to per-workspace card data. */
export type WorkspaceListFacts = {
  ws: {
    id: string
    name: string
    branch: string
    kind: 'git' | 'folder'
    isPinned: boolean
    isUnread: boolean
    isMain: boolean
    hasComment: boolean
    /** The workspace status lane id, such as `in-progress`. */
    status: string
    lastActivityAt: number
    createdAt: number
  }
  repo: { id: string; name: string; ssh: boolean } | null
  /** The pull request lane, as Group by PR names it: `in-progress`, `in-review`, `done` or `closed`. */
  review: { lane: string }
  /** What the agents need: `needs-you`, `working`, `done`, or null when none ran. */
  activity: { tier: string | null }
}

export function buildWorkspaceListFacts(
  worktree: Worktree,
  repo: Repo | undefined,
  prLane: PRGroupKey
): WorkspaceListFacts {
  return {
    ws: {
      id: worktree.id,
      name: worktree.displayName,
      branch: worktree.branch.replace(/^refs\/heads\//, ''),
      kind: repo && isFolderRepo(repo) ? 'folder' : 'git',
      isPinned: worktree.isPinned,
      isUnread: worktree.isUnread,
      isMain: worktree.isMainWorktree,
      hasComment: worktree.comment.trim().length > 0,
      status: worktree.workspaceStatus ?? '',
      lastActivityAt: worktree.lastActivityAt,
      createdAt: worktree.createdAt ?? 0
    },
    repo: repo ? { id: repo.id, name: repo.displayName, ssh: Boolean(repo.connectionId) } : null,
    review: { lane: prLane },
    activity: { tier: worktree.smartTier ?? null }
  }
}

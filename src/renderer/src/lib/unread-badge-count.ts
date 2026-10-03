import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'

/** The only fields the count reads, so a projection over them is a sound cache key. */
export type UnreadBadgeWorktree = Pick<Worktree, 'id' | 'hostId' | 'isUnread' | 'isArchived'>

export type UnreadBadgeCountSources = {
  worktreesByRepo: Readonly<Record<string, readonly UnreadBadgeWorktree[]>>
  folderWorkspaces: readonly Pick<FolderWorkspace, 'isUnread'>[]
}

/**
 * Why workspace flags only: the flag is what the sidebar draws and what visiting a workspace
 * clears. Tab markers outlive both, so counting them left a number with nothing to find (#23363).
 */
export function getUnreadBadgeCount({
  worktreesByRepo,
  folderWorkspaces
}: UnreadBadgeCountSources): number {
  // Why host identity: a repo on two hosts publishes one id for two sidebar rows.
  const unreadWorktrees = new Set<string>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      // Why: the sidebar never renders an archived worktree; folder rows have no such filter.
      if (worktree.isUnread && !worktree.isArchived) {
        unreadWorktrees.add(getWorktreeHostIdentity(worktree))
      }
    }
  }

  let count = unreadWorktrees.size
  for (const folderWorkspace of folderWorkspaces) {
    if (folderWorkspace.isUnread) {
      count += 1
    }
  }
  return count
}

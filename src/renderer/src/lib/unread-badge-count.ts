import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { Worktree } from '../../../shared/worktree/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

/** The only worktree fields the count reads, so a projection over them is a sound cache key. */
export type UnreadBadgeWorktree = Pick<Worktree, 'id' | 'isUnread' | 'isArchived'>

/** The only folder-workspace fields the count reads, so a projection over them is a sound cache key. */
export type UnreadBadgeFolderWorkspace = Pick<FolderWorkspace, 'id' | 'isUnread' | 'isArchived'>

/** Everything the Dock badge count depends on. Tab-level unread markers are deliberately absent. */
export type UnreadBadgeCountSources = {
  worktreesByRepo: Readonly<Record<string, readonly UnreadBadgeWorktree[]>>
  folderWorkspaces: readonly UnreadBadgeFolderWorkspace[]
  /** Precomputed floating-workspace unread, already gated on the floating terminal being enabled. */
  floatingWorkspaceHasUnread: boolean
}

/**
 * Number of distinct workspaces the Dock badge reports: non-archived worktrees and folder
 * workspaces whose unread flag is set, plus the floating workspace when it holds unread activity.
 */
export function getUnreadBadgeCount({
  worktreesByRepo,
  folderWorkspaces,
  floatingWorkspaceHasUnread
}: UnreadBadgeCountSources): number {
  // Why flags only: the workspace flag is what the sidebar shows and what visiting or
  // "Mark as read" clears, so a tab marker alone must not hold a badge nobody can find.
  const unreadWorkspaceKeys = new Set<string>()

  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (worktree.isUnread && !worktree.isArchived) {
        unreadWorkspaceKeys.add(worktree.id)
      }
    }
  }

  for (const folderWorkspace of folderWorkspaces) {
    if (folderWorkspace.isUnread && !folderWorkspace.isArchived) {
      unreadWorkspaceKeys.add(folderWorkspaceKey(folderWorkspace.id))
    }
  }

  if (floatingWorkspaceHasUnread) {
    unreadWorkspaceKeys.add(FLOATING_TERMINAL_WORKTREE_ID)
  }

  return unreadWorkspaceKeys.size
}

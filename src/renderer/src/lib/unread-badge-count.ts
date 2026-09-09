import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'

/** The only fields the count reads, so a projection over them is a sound cache key. */
export type UnreadBadgeWorktree = Pick<Worktree, 'id' | 'isUnread'>
export type UnreadBadgeTab = Pick<TerminalTab, 'id'>

export type UnreadBadgeCountSources = {
  worktreesByRepo: Readonly<Record<string, readonly UnreadBadgeWorktree[]>>
  tabsByWorktree: Readonly<Record<string, readonly UnreadBadgeTab[]>>
  unreadTerminalTabs: Readonly<Record<string, true>>
}

export function getUnreadBadgeCount({
  worktreesByRepo,
  tabsByWorktree,
  unreadTerminalTabs
}: UnreadBadgeCountSources): number {
  const unreadWorktreeIds = new Set<string>()

  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (worktree.isUnread) {
        unreadWorktreeIds.add(worktree.id)
      }
    }
  }

  const unreadTabIds = new Set(Object.keys(unreadTerminalTabs))
  if (unreadTabIds.size === 0) {
    return unreadWorktreeIds.size
  }

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      if (!unreadTabIds.delete(tab.id)) {
        continue
      }
      unreadWorktreeIds.add(worktreeId)
    }
  }

  // Why: tab unread state should normally map to a live worktree, but counting
  // unmatched entries keeps the Dock badge honest during hydration races.
  return unreadWorktreeIds.size + unreadTabIds.size
}

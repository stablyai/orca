import type { Worktree } from '../../../../shared/worktree/types'

/** What a collapsed lineage hides, so its child chip can still surface it. */
export type LineageHiddenDescendants = {
  worktreeIds: string[]
  unreadCount: number
}

/** Every worktree under `children`, depth-first; a repeated node (cycle) is visited once. */
export function collectLineageHiddenDescendants(
  children: readonly Worktree[],
  getChildren: (worktree: Worktree) => readonly Worktree[]
): LineageHiddenDescendants {
  const worktreeIds: string[] = []
  let unreadCount = 0
  const seen = new Set<Worktree>()
  const pending = [...children]
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (seen.has(next)) {
      continue
    }
    seen.add(next)
    worktreeIds.push(next.id)
    if (next.isUnread) {
      unreadCount += 1
    }
    pending.push(...getChildren(next))
  }
  return { worktreeIds, unreadCount }
}

import type { AppState } from '@/store'
import { getWorktreeIdFromVisitKey } from '@/lib/worktree-visit-recency'

// Why: recently used workspaces keep their watch so switching back needs no re-read.
export const WARM_RECURSIVE_WATCH_WORKSPACE_COUNT = 3
// Why: deleted/renamed-tab pins sit outside the recency set, so bound them or they grow without limit.
export const PINNED_RECURSIVE_WATCH_WORKSPACE_COUNT = 3

function mostRecent(
  ids: Iterable<string>,
  visitedAtById: ReadonlyMap<string, number>,
  count: number
): string[] {
  return [...ids]
    .sort((left, right) => (visitedAtById.get(right) ?? 0) - (visitedAtById.get(left) ?? 0))
    .slice(0, count)
}

/** Watch active/recent workspaces plus bounded deleted/renamed-tab pins. */
export function selectWatchEligibleWorkspaceIds(args: {
  activeWorktreeId: string | null
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>> | undefined
  openFiles: AppState['openFiles']
  exists: (workspaceId: string) => boolean
}): ReadonlySet<string> {
  const ids = new Set<string>()
  if (args.activeWorktreeId) {
    ids.add(args.activeWorktreeId)
  }
  // Why: one visit map entry per host, so take each workspace's latest.
  const visitedAtById = new Map<string, number>()
  for (const [key, visitedAt] of Object.entries(args.lastVisitedAtByWorktreeId ?? {})) {
    const id = getWorktreeIdFromVisitKey(key)
    visitedAtById.set(id, Math.max(visitedAtById.get(id) ?? 0, visitedAt))
  }
  const warmCandidates = [...visitedAtById.keys()].filter(
    // Why: `exists` keeps deleted workspaces from holding warm slots.
    (id) => id !== args.activeWorktreeId && args.exists(id)
  )
  for (const id of mostRecent(
    warmCandidates,
    visitedAtById,
    WARM_RECURSIVE_WATCH_WORKSPACE_COUNT
  )) {
    ids.add(id)
  }
  // Why: a live watch clears a deleted/renamed mark the moment the file reappears; a catch-up only re-checks on switch-back.
  const pinned = new Set<string>()
  for (const file of args.openFiles) {
    if (
      (file.externalMutation === 'deleted' || file.externalMutation === 'renamed') &&
      !ids.has(file.worktreeId)
    ) {
      pinned.add(file.worktreeId)
    }
  }
  for (const id of mostRecent(pinned, visitedAtById, PINNED_RECURSIVE_WATCH_WORKSPACE_COUNT)) {
    ids.add(id)
  }
  return ids
}

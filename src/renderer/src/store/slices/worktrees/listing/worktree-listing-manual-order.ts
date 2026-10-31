import type { Worktree } from '../../../../../../shared/worktree/types'

export function preserveConcurrentManualOrder<T extends Worktree>(
  incoming: readonly T[],
  requestStarted: readonly Worktree[] | undefined,
  current: readonly Worktree[] | undefined,
  matchesRefreshHost: (worktree: Worktree) => boolean
): T[] {
  if (!requestStarted || !current) {
    return [...incoming]
  }
  const startedById = new Map(
    requestStarted.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  const currentById = new Map(
    current.filter(matchesRefreshHost).map((worktree) => [worktree.id, worktree])
  )
  return incoming.map((worktree) => {
    const started = startedById.get(worktree.id)
    const latest = currentById.get(worktree.id)
    if (!started || !latest || started.manualOrder === latest.manualOrder) {
      return worktree
    }
    // Why: a refresh response may predate a completed drag; the renderer's optimistic rank is newer.
    return { ...worktree, manualOrder: latest.manualOrder }
  })
}

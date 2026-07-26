const MAX_REFRESH_ORDERING_WORKTREES = 1024
const strictUpstreamRefreshGenerationByWorktree = new Map<string, number>()
const automaticRefreshGenerationByWorktree = new Map<string, number>()
// Why: automatic ordering is latest-APPLIED-wins, not latest-started-wins. A
// later-started refresh that fails (or never applies) must not veto an earlier
// refresh's good result, so the fence only advances when a result is applied.
const lastAppliedAutomaticGenerationByWorktree = new Map<string, number>()
const automaticUpstreamRefreshInFlightByWorktree = new Map<string, number>()

export type AutomaticRefreshOrder = {
  strictGeneration: number
  automaticGeneration: number
}

function trimRefreshOrderingState(): void {
  for (const worktreeId of strictUpstreamRefreshGenerationByWorktree.keys()) {
    if (strictUpstreamRefreshGenerationByWorktree.size <= MAX_REFRESH_ORDERING_WORKTREES) {
      break
    }
    if (automaticUpstreamRefreshInFlightByWorktree.has(worktreeId)) {
      continue
    }
    strictUpstreamRefreshGenerationByWorktree.delete(worktreeId)
  }
}

export function beginAutomaticUpstreamRefresh(worktreeId: string): AutomaticRefreshOrder {
  automaticUpstreamRefreshInFlightByWorktree.set(
    worktreeId,
    (automaticUpstreamRefreshInFlightByWorktree.get(worktreeId) ?? 0) + 1
  )
  const automaticGeneration = (automaticRefreshGenerationByWorktree.get(worktreeId) ?? 0) + 1
  automaticRefreshGenerationByWorktree.set(worktreeId, automaticGeneration)
  return {
    strictGeneration: strictUpstreamRefreshGenerationByWorktree.get(worktreeId) ?? 0,
    automaticGeneration
  }
}

export function finishAutomaticUpstreamRefresh(worktreeId: string): void {
  const count = automaticUpstreamRefreshInFlightByWorktree.get(worktreeId) ?? 0
  if (count <= 1) {
    automaticUpstreamRefreshInFlightByWorktree.delete(worktreeId)
    automaticRefreshGenerationByWorktree.delete(worktreeId)
    lastAppliedAutomaticGenerationByWorktree.delete(worktreeId)
  } else {
    automaticUpstreamRefreshInFlightByWorktree.set(worktreeId, count - 1)
  }
  trimRefreshOrderingState()
}

export function shouldApplyAutomaticUpstreamRefresh(
  worktreeId: string,
  order: AutomaticRefreshOrder,
  shouldApply?: () => boolean
): boolean {
  return (
    (strictUpstreamRefreshGenerationByWorktree.get(worktreeId) ?? 0) === order.strictGeneration &&
    order.automaticGeneration >= (lastAppliedAutomaticGenerationByWorktree.get(worktreeId) ?? 0) &&
    (shouldApply?.() ?? true)
  )
}

/**
 * Check-and-claim variant used immediately before applying state. On success
 * it advances the applied fence so an older concurrent refresh that settles
 * later cannot overwrite this refresh's newer result.
 */
export function claimAutomaticUpstreamRefreshApply(
  worktreeId: string,
  order: AutomaticRefreshOrder,
  shouldApply?: () => boolean
): boolean {
  if (!shouldApplyAutomaticUpstreamRefresh(worktreeId, order, shouldApply)) {
    return false
  }
  lastAppliedAutomaticGenerationByWorktree.set(
    worktreeId,
    Math.max(
      lastAppliedAutomaticGenerationByWorktree.get(worktreeId) ?? 0,
      order.automaticGeneration
    )
  )
  return true
}

export function beginStrictUpstreamRefresh(worktreeId: string): void {
  strictUpstreamRefreshGenerationByWorktree.set(
    worktreeId,
    (strictUpstreamRefreshGenerationByWorktree.get(worktreeId) ?? 0) + 1
  )
  trimRefreshOrderingState()
}

export function clearGitStatusRefreshOrderingStateForTests(): void {
  strictUpstreamRefreshGenerationByWorktree.clear()
  automaticRefreshGenerationByWorktree.clear()
  lastAppliedAutomaticGenerationByWorktree.clear()
  automaticUpstreamRefreshInFlightByWorktree.clear()
}

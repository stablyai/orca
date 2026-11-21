// Bound the recent working set independently of visibility-filtered ownership maps.
export const HUGE_REPO_WARNING_DISMISSAL_MAX_WORKTREES = 1024

export type HugeRepoWarningWorktreeIdentity = {
  id: string
  instanceId?: string
}

export type HugeRepoWarningProbe = {
  readonly worktreeId: string
  readonly instanceId: string
  readonly lifecycleToken: symbol
}

type HugeRepoWarningWorktreeState = {
  instanceId: string
  lifecycleToken: symbol
  dismissed: boolean
}

const hugeRepoWarningStateByWorktreeId = new Map<string, HugeRepoWarningWorktreeState>()

function refreshHugeRepoWarningState(
  worktreeId: string,
  state: HugeRepoWarningWorktreeState
): void {
  hugeRepoWarningStateByWorktreeId.delete(worktreeId)
  hugeRepoWarningStateByWorktreeId.set(worktreeId, state)
  while (hugeRepoWarningStateByWorktreeId.size > HUGE_REPO_WARNING_DISMISSAL_MAX_WORKTREES) {
    const oldestWorktreeId = hugeRepoWarningStateByWorktreeId.keys().next().value
    if (oldestWorktreeId === undefined) {
      break
    }
    hugeRepoWarningStateByWorktreeId.delete(oldestWorktreeId)
  }
}

export function beginHugeRepoWarningProbe(
  worktree: HugeRepoWarningWorktreeIdentity
): HugeRepoWarningProbe {
  const instanceId = worktree.instanceId ?? ''
  let state = hugeRepoWarningStateByWorktreeId.get(worktree.id)
  if (!state || state.instanceId !== instanceId) {
    state = { instanceId, lifecycleToken: Symbol(worktree.id), dismissed: false }
  }
  refreshHugeRepoWarningState(worktree.id, state)
  return {
    worktreeId: worktree.id,
    instanceId,
    lifecycleToken: state.lifecycleToken
  }
}

export function hasDismissedHugeRepoWarning(probe: HugeRepoWarningProbe): boolean {
  const state = hugeRepoWarningStateByWorktreeId.get(probe.worktreeId)
  if (!state || state.lifecycleToken !== probe.lifecycleToken || !state.dismissed) {
    return false
  }
  refreshHugeRepoWarningState(probe.worktreeId, state)
  return true
}

export function markHugeRepoWarningDismissed(probe: HugeRepoWarningProbe): boolean {
  const state = hugeRepoWarningStateByWorktreeId.get(probe.worktreeId)
  if (!state || state.lifecycleToken !== probe.lifecycleToken) {
    return false
  }
  state.dismissed = true
  refreshHugeRepoWarningState(probe.worktreeId, state)
  return true
}

export function migrateHugeRepoWarningDismissal(
  oldWorktreeId: string,
  newWorktreeId: string
): void {
  if (oldWorktreeId === newWorktreeId) {
    return
  }
  const state = hugeRepoWarningStateByWorktreeId.get(oldWorktreeId)
  if (!state) {
    return
  }
  hugeRepoWarningStateByWorktreeId.delete(oldWorktreeId)
  // Preserve once-per-worktree dismissal while invalidating probes that captured the pre-rename path.
  refreshHugeRepoWarningState(newWorktreeId, {
    ...state,
    lifecycleToken: Symbol(newWorktreeId)
  })
}

export function forgetHugeRepoWarningDismissalsForWorktrees(
  removedWorktreeIds: Iterable<string>
): void {
  const removedIds = new Set(removedWorktreeIds)
  if (removedIds.size === 0) {
    return
  }
  for (const worktreeId of removedIds) {
    // Invalidate outstanding probe tokens on removal so late completions cannot resurrect dismissals.
    hugeRepoWarningStateByWorktreeId.delete(worktreeId)
  }
}

export function clearHugeRepoWarningDismissalsForTests(): void {
  hugeRepoWarningStateByWorktreeId.clear()
}

export function getHugeRepoWarningStateCountForTests(): number {
  return hugeRepoWarningStateByWorktreeId.size
}

export function getHugeRepoWarningDismissalCountForTests(): number {
  let count = 0
  for (const state of hugeRepoWarningStateByWorktreeId.values()) {
    if (state.dismissed) {
      count += 1
    }
  }
  return count
}

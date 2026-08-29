/**
 * Removal hysteresis for the "Hide sleeping" sidebar sweep (#15996).
 *
 * Why: the sweep's liveness inputs are volatile. `ptyIdsByTabId` is emptied and
 * refilled whenever a pane rebinds its PTY — an SSH reconnect, a remote-runtime
 * pane re-attaching after a workspace switch — and `worktreeIdsWithLiveAgent`
 * only holds a row while its agent status is fresh and non-done. A workspace
 * with an open-but-idle session therefore hangs on `ptyIdsByTabId` alone, and a
 * single-commit gap in that map sweeps the row out and back in one frame: the
 * list jumps by a full row height and snaps back.
 *
 * Why hysteresis and not an in-flight flag: direct-SSH panes expose one
 * (`directSshPaneRetryByTabId`), but remote-runtime panes keep their recovery
 * state in `RemoteRuntimePtyRecoveryState`, outside the store, so no sidebar
 * selector can see it. Delaying *removal* covers every rebind path without
 * needing the producer to advertise itself.
 *
 * Only removal is delayed. Appearing stays immediate, and a workspace that was
 * already asleep when the sidebar first saw it is swept with no grace at all,
 * so this never resurrects a row that should have been hidden from the start.
 */

/**
 * Why 1.5s: long enough to cover a remote pane rebinding its PTY over a slow
 * link, short enough that genuinely closing a workspace's last session still
 * reads as immediate. The cost of overshooting is a row that lingers a beat;
 * the cost of undershooting is the jitter this exists to stop.
 */
export const SLEEPING_SWEEP_SETTLE_MS = 1_500

export type SleepingSweepRetentionState = {
  /** Workspaces observed active at least once; only these earn a grace window. */
  seenActiveIds: Set<string>
  /** worktreeId → epoch ms it first read inactive after having been active. */
  inactiveSinceById: Map<string, number>
}

export function createSleepingSweepRetentionState(): SleepingSweepRetentionState {
  return { seenActiveIds: new Set(), inactiveSinceById: new Map() }
}

export type SleepingSweepRetentionResult = {
  /** Ids to exempt from this pass's sweep. */
  retainedIds: ReadonlySet<string>
  /** ms until the soonest grace window expires, or null when none is open. */
  nextExpiryInMs: number | null
}

const EMPTY_RETAINED_IDS: ReadonlySet<string> = new Set()

/**
 * Advance the grace bookkeeping one pass and report which workspaces the sweep
 * must skip. Mutates `state`, but is idempotent for a given (nowMs, isActive)
 * pair so a double-invoked render cannot double-count a grace window.
 */
export function updateSleepingSweepRetention(args: {
  state: SleepingSweepRetentionState
  candidateWorktreeIds: readonly string[]
  isActive: (worktreeId: string) => boolean
  nowMs: number
  settleMs?: number
}): SleepingSweepRetentionResult {
  const { state, candidateWorktreeIds, isActive, nowMs } = args
  const settleMs = args.settleMs ?? SLEEPING_SWEEP_SETTLE_MS
  const candidates = new Set(candidateWorktreeIds)

  // Why prune first: ids that left worktreesByRepo (deleted, archived, repo
  // removed) must not keep a grace window alive against a future id reuse.
  for (const id of state.seenActiveIds) {
    if (!candidates.has(id)) {
      state.seenActiveIds.delete(id)
      state.inactiveSinceById.delete(id)
    }
  }

  let retainedIds: Set<string> | null = null
  let nextExpiryInMs: number | null = null

  for (const worktreeId of candidates) {
    if (isActive(worktreeId)) {
      state.seenActiveIds.add(worktreeId)
      state.inactiveSinceById.delete(worktreeId)
      continue
    }
    if (!state.seenActiveIds.has(worktreeId)) {
      continue
    }
    let inactiveSince = state.inactiveSinceById.get(worktreeId)
    if (inactiveSince === undefined) {
      inactiveSince = nowMs
      state.inactiveSinceById.set(worktreeId, inactiveSince)
    }
    const remainingMs = settleMs - (nowMs - inactiveSince)
    if (remainingMs <= 0) {
      state.seenActiveIds.delete(worktreeId)
      state.inactiveSinceById.delete(worktreeId)
      continue
    }
    retainedIds ??= new Set()
    retainedIds.add(worktreeId)
    nextExpiryInMs = nextExpiryInMs === null ? remainingMs : Math.min(nextExpiryInMs, remainingMs)
  }

  return { retainedIds: retainedIds ?? EMPTY_RETAINED_IDS, nextExpiryInMs }
}

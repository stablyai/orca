/** Bounded wait before a paired-runtime pane with no PTY spawns its own shell (#15622). */
export const RUNTIME_SNAPSHOT_SPAWN_WAIT_MS = 10_000
/** Timer-based re-check cadence; hidden tabs get no animation frames. */
export const RUNTIME_SNAPSHOT_SPAWN_POLL_MS = 200

export type RuntimePaneSpawnGateInput = {
  /** Remote runtime owning the worktree; null = local/SSH pane, never gated. */
  runtimeEnvironmentId: string | null
  /** Whether the tab already has a PTY binding (restore reattach path) — never gated. */
  hasPtyBinding: boolean
  /** Whether the runtime's first authoritative session.tabs snapshot was accepted. */
  snapshotAccepted: boolean
  /** Whether the pane carries a preserved sleep-resume PTY handle — an
   * intentional cold-spawn resume that must connect immediately, not a stale row. */
  hasRestoredPtyHandle: boolean
  /** Epoch ms when the wait started, null before the first deferred decision. */
  waitStartedAt: number | null
  now: number
}

export type RuntimePaneSpawnGateDecision = {
  /** True while the pane must keep waiting instead of spawning. */
  defer: boolean
  /** The wait-start timestamp to carry into the next decision. */
  waitStartedAt: number
}

/**
 * A restored PTY-less terminal row on a paired-runtime worktree must not spawn
 * on mount (#15622): each mount-created remote shell turns a stale row into a
 * live terminal. The first accepted session.tabs snapshot either attaches the
 * pane to the host's existing PTY (the connect path then reattaches instead of
 * spawning) or drops the stale row. The wait is bounded so an unreachable
 * runtime still gets a working pane after the deadline.
 */
export function shouldDeferRuntimePaneSpawn(
  input: RuntimePaneSpawnGateInput
): RuntimePaneSpawnGateDecision {
  const waitStartedAt = input.waitStartedAt ?? input.now
  const defer =
    input.runtimeEnvironmentId !== null &&
    !input.hasPtyBinding &&
    !input.hasRestoredPtyHandle &&
    !input.snapshotAccepted &&
    input.now - waitStartedAt < RUNTIME_SNAPSHOT_SPAWN_WAIT_MS
  return { defer, waitStartedAt }
}

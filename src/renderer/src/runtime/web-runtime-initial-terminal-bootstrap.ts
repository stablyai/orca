/**
 * Which runtime-owned workspaces already have an initial-terminal bootstrap in flight.
 *
 * The bootstrap used to be latched by a `let` inside the session-tabs subscription closure, which
 * made "one focus creates at most one terminal" true only for as long as that one closure lived.
 * Its effect re-runs whenever the environment, connection generation, pairing revision, or
 * session-ready flag settles — all of which move during a workspace switch — so a second closure
 * re-armed the flag while the first create was still in flight and seeded a second terminal
 * (STA-6173). This latch outlives the closures.
 *
 * It is keyed by environment AND worktree, not worktree alone: a worktree id is `repoId::path` with
 * no host component, so the same id can be live on two paired runtimes at once (STA-4343). Keying
 * per environment lets a per-environment teardown release only its own in-flight keys — clearing
 * every environment's latch would release a sibling environment's pending create and let a new
 * subscription for it seed a duplicate, which is this very bug through another door.
 *
 * `creating` blocks every other closure while the create RPC is in flight. `awaiting-mirror` is a
 * create that resolved without the mirror yet holding a row for the worktree: the host may have the
 * tab and the frame simply has not landed, so the latch stays held — releasing here is what let the
 * next empty frame seed a duplicate. The next frame the mirror accepts for that worktree is its
 * answer either way (a row now exists and the predicate declines on its own, or the host genuinely
 * has no terminal and a retry is right), so that frame releases it. Without that release a create
 * whose frame never lands would suppress every later auto-seed until environment teardown.
 */
type InitialTerminalBootstrapPhase = 'creating' | 'awaiting-mirror'

const phaseByWorktreeByEnvironment = new Map<string, Map<string, InitialTerminalBootstrapPhase>>()

export function isWebRuntimeInitialTerminalBootstrapInFlight(
  environmentId: string,
  worktreeId: string
): boolean {
  return phaseByWorktreeByEnvironment.get(environmentId)?.has(worktreeId) ?? false
}

/** Claims the bootstrap for this environment's worktree; false when another closure already holds it. */
export function beginWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): boolean {
  const phases = phaseByWorktreeByEnvironment.get(environmentId)
  if (phases?.has(worktreeId)) {
    return false
  }
  if (phases) {
    phases.set(worktreeId, 'creating')
  } else {
    phaseByWorktreeByEnvironment.set(environmentId, new Map([[worktreeId, 'creating']]))
  }
  return true
}

/** The create resolved but no mirrored row exists yet; hold until the mirror answers. */
export function markWebRuntimeInitialTerminalBootstrapAwaitingMirror(
  environmentId: string,
  worktreeId: string
): void {
  const phases = phaseByWorktreeByEnvironment.get(environmentId)
  if (phases?.has(worktreeId)) {
    phases.set(worktreeId, 'awaiting-mirror')
  }
}

export function endWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): void {
  const phases = phaseByWorktreeByEnvironment.get(environmentId)
  if (!phases) {
    return
  }
  phases.delete(worktreeId)
  if (phases.size === 0) {
    phaseByWorktreeByEnvironment.delete(environmentId)
  }
}

/**
 * Release a bootstrap that was only waiting on the mirror. A create still in flight keeps its claim:
 * releasing it on a frame is exactly the re-armed-closure race this latch exists to close.
 */
export function releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame(
  environmentId: string,
  worktreeId: string
): void {
  if (phaseByWorktreeByEnvironment.get(environmentId)?.get(worktreeId) === 'awaiting-mirror') {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
  }
}

export function clearWebRuntimeInitialTerminalBootstrapsForEnvironment(
  environmentId: string
): void {
  phaseByWorktreeByEnvironment.delete(environmentId)
}

export function clearAllWebRuntimeInitialTerminalBootstraps(): void {
  phaseByWorktreeByEnvironment.clear()
}

export function resetWebRuntimeInitialTerminalBootstrapForTests(): void {
  clearAllWebRuntimeInitialTerminalBootstraps()
}

export function countWebRuntimeInitialTerminalBootstrapEnvironmentsForTests(): number {
  return phaseByWorktreeByEnvironment.size
}

export function countWebRuntimeInitialTerminalBootstrapEntriesForTests(): number {
  let total = 0
  for (const phases of phaseByWorktreeByEnvironment.values()) {
    total += phases.size
  }
  return total
}

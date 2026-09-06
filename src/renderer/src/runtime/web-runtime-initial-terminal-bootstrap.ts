/**
 * Which runtime-owned workspaces already have an initial-terminal bootstrap in flight.
 *
 * The bootstrap used to be latched by a `let` inside the session-tabs subscription closure, which
 * made "one focus creates at most one terminal" true only for as long as that one closure lived.
 * Its effect re-runs whenever the environment, connection generation, pairing revision, or
 * session-ready flag settles — all of which move during a workspace switch — so a second closure
 * re-armed the flag while the first create was still in flight and seeded a second terminal
 * (STA-6173). This latch outlives the closures. It is released when the create settles: by then the
 * create has awaited its own snapshot refresh, so the host's tab is mirrored and the predicate
 * declines on its own, while a failed create is free to be retried by a later focus.
 */
const initialTerminalBootstrapInFlightByWorktree = new Set<string>()

export function isWebRuntimeInitialTerminalBootstrapInFlight(worktreeId: string): boolean {
  return initialTerminalBootstrapInFlightByWorktree.has(worktreeId)
}

/** Claims the bootstrap for this worktree; false when another closure already holds it. */
export function beginWebRuntimeInitialTerminalBootstrap(worktreeId: string): boolean {
  if (initialTerminalBootstrapInFlightByWorktree.has(worktreeId)) {
    return false
  }
  initialTerminalBootstrapInFlightByWorktree.add(worktreeId)
  return true
}

export function endWebRuntimeInitialTerminalBootstrap(worktreeId: string): void {
  initialTerminalBootstrapInFlightByWorktree.delete(worktreeId)
}

export function clearAllWebRuntimeInitialTerminalBootstraps(): void {
  initialTerminalBootstrapInFlightByWorktree.clear()
}

export function resetWebRuntimeInitialTerminalBootstrapForTests(): void {
  clearAllWebRuntimeInitialTerminalBootstraps()
}

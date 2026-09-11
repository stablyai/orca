/**
 * Which workspaces already have a post-wake terminal respawn in flight.
 *
 * Keyed by environment AND worktree, for the same two reasons as the initial-terminal bootstrap
 * latch next door (see web-runtime-initial-terminal-bootstrap.ts). A worktree id is `repoId::path`
 * with no host component, so the same id can be live on two paired runtimes at once (STA-4343):
 * keyed by worktree alone, one runtime's respawn suppressed the other's, and one runtime's release
 * freed the other's claim. And keying per environment is what lets a per-environment teardown
 * release only its own in-flight keys — clearing every environment's latch releases a sibling's
 * pending create and lets a new subscription for it seed a duplicate (STA-6173).
 */
const wakeTerminalRespawnInFlightByEnvironment = new Map<string, Set<string>>()

export function shouldSkipWebRuntimeWakeTerminalRespawn(
  environmentId: string,
  worktreeId: string
): boolean {
  return wakeTerminalRespawnInFlightByEnvironment.get(environmentId)?.has(worktreeId) ?? false
}

/** Claims the respawn for this environment's worktree; false when another closure already holds it. */
export function beginWebRuntimeWakeTerminalRespawn(
  environmentId: string,
  worktreeId: string
): boolean {
  const inFlight = wakeTerminalRespawnInFlightByEnvironment.get(environmentId)
  if (inFlight?.has(worktreeId)) {
    return false
  }
  if (inFlight) {
    inFlight.add(worktreeId)
  } else {
    wakeTerminalRespawnInFlightByEnvironment.set(environmentId, new Set([worktreeId]))
  }
  return true
}

export function endWebRuntimeWakeTerminalRespawn(environmentId: string, worktreeId: string): void {
  const inFlight = wakeTerminalRespawnInFlightByEnvironment.get(environmentId)
  if (!inFlight) {
    return
  }
  inFlight.delete(worktreeId)
  if (inFlight.size === 0) {
    wakeTerminalRespawnInFlightByEnvironment.delete(environmentId)
  }
}

export function clearWebRuntimeWakeTerminalRespawnForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  endWebRuntimeWakeTerminalRespawn(environmentId, worktreeId)
}

export function clearWebRuntimeWakeTerminalRespawnForEnvironment(environmentId: string): void {
  wakeTerminalRespawnInFlightByEnvironment.delete(environmentId)
}

export function resetWebRuntimeWakeTerminalRespawnForTests(): void {
  wakeTerminalRespawnInFlightByEnvironment.clear()
}

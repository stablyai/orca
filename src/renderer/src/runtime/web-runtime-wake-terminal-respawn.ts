const wakeTerminalRespawnInFlightByWorktree = new Set<string>()

// Why: env-scoped keys let one environment's teardown clear only its own
// in-flight guards instead of releasing every environment's.
function wakeRespawnKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}`
}

export function shouldSkipWebRuntimeWakeTerminalRespawn(
  environmentId: string,
  worktreeId: string
): boolean {
  return wakeTerminalRespawnInFlightByWorktree.has(wakeRespawnKey(environmentId, worktreeId))
}

export function beginWebRuntimeWakeTerminalRespawn(
  environmentId: string,
  worktreeId: string
): boolean {
  const key = wakeRespawnKey(environmentId, worktreeId)
  if (wakeTerminalRespawnInFlightByWorktree.has(key)) {
    return false
  }
  wakeTerminalRespawnInFlightByWorktree.add(key)
  return true
}

export function endWebRuntimeWakeTerminalRespawn(environmentId: string, worktreeId: string): void {
  wakeTerminalRespawnInFlightByWorktree.delete(wakeRespawnKey(environmentId, worktreeId))
}

export function clearWebRuntimeWakeTerminalRespawnForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  wakeTerminalRespawnInFlightByWorktree.delete(wakeRespawnKey(environmentId, worktreeId))
}

export function clearWebRuntimeWakeTerminalRespawnForEnvironment(environmentId: string): void {
  const keyPrefix = `${environmentId}\0`
  for (const key of wakeTerminalRespawnInFlightByWorktree) {
    if (key.startsWith(keyPrefix)) {
      wakeTerminalRespawnInFlightByWorktree.delete(key)
    }
  }
}

export function resetWebRuntimeWakeTerminalRespawnForTests(): void {
  wakeTerminalRespawnInFlightByWorktree.clear()
}

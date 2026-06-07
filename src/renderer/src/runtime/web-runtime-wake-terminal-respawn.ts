const wakeTerminalRespawnRequestedByWorktree = new Set<string>()
const wakeTerminalRespawnInFlightByWorktree = new Set<string>()

export function shouldSkipWebRuntimeWakeTerminalRespawn(worktreeId: string): boolean {
  return (
    wakeTerminalRespawnRequestedByWorktree.has(worktreeId) ||
    wakeTerminalRespawnInFlightByWorktree.has(worktreeId)
  )
}

export function beginWebRuntimeWakeTerminalRespawn(worktreeId: string): boolean {
  if (shouldSkipWebRuntimeWakeTerminalRespawn(worktreeId)) {
    return false
  }
  wakeTerminalRespawnRequestedByWorktree.add(worktreeId)
  wakeTerminalRespawnInFlightByWorktree.add(worktreeId)
  return true
}

export function endWebRuntimeWakeTerminalRespawn(worktreeId: string): void {
  wakeTerminalRespawnInFlightByWorktree.delete(worktreeId)
}

export function resetWebRuntimeWakeTerminalRespawnForTests(): void {
  wakeTerminalRespawnRequestedByWorktree.clear()
  wakeTerminalRespawnInFlightByWorktree.clear()
}

const wakeTerminalRespawnInFlightByWorktree = new Set<string>()

export function shouldSkipWebRuntimeWakeTerminalRespawn(worktreeId: string): boolean {
  return wakeTerminalRespawnInFlightByWorktree.has(worktreeId)
}

export function beginWebRuntimeWakeTerminalRespawn(worktreeId: string): boolean {
  if (wakeTerminalRespawnInFlightByWorktree.has(worktreeId)) {
    return false
  }
  wakeTerminalRespawnInFlightByWorktree.add(worktreeId)
  return true
}

export function endWebRuntimeWakeTerminalRespawn(worktreeId: string): void {
  wakeTerminalRespawnInFlightByWorktree.delete(worktreeId)
}

export function clearWebRuntimeWakeTerminalRespawnForWorktree(worktreeId: string): void {
  wakeTerminalRespawnInFlightByWorktree.delete(worktreeId)
}

export function clearAllWebRuntimeWakeTerminalRespawn(): void {
  wakeTerminalRespawnInFlightByWorktree.clear()
}

export function resetWebRuntimeWakeTerminalRespawnForTests(): void {
  clearAllWebRuntimeWakeTerminalRespawn()
}

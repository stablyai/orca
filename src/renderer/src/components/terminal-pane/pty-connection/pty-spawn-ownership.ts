/**
 * Transfers retirement authority when a watchdog remount adopts an in-flight
 * main-side spawn. The predecessor must only skip cleanup after a successor
 * claims the exact returned PTY, so genuinely unowned late results are still
 * killed.
 */
type Handoff = { ptyId: string | null; claimed: boolean }

const handoffsByPaneKey = new Map<string, Handoff>()

export function revokePtySpawnRetirement(paneKey: string): void {
  handoffsByPaneKey.set(paneKey, { ptyId: null, claimed: false })
}

export function claimPtySpawnRetirement(paneKey: string, ptyId: string): void {
  const handoff = handoffsByPaneKey.get(paneKey)
  if (!handoff) {
    return
  }
  if (handoff.ptyId === null) {
    handoff.ptyId = ptyId
  }
  if (handoff.ptyId === ptyId) {
    handoff.claimed = true
  }
}

export function successorOwnsPtySpawn(paneKey: string, ptyId: string): boolean {
  const handoff = handoffsByPaneKey.get(paneKey)
  return handoff?.ptyId === ptyId && handoff.claimed
}

export function clearPtySpawnRetirementHandoff(paneKey: string): void {
  handoffsByPaneKey.delete(paneKey)
}

export function resetPtySpawnOwnershipForTests(): void {
  handoffsByPaneKey.clear()
}

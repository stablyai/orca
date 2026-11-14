// In-app session creation bypasses the cache so the new session appears promptly.
// Keep the budget at module scope so tab remounts cannot amplify full scans.
const FORCED_RESCAN_MIN_INTERVAL_MS = 30_000
let lastForcedRescanAt = 0

/** Takes the shared forced-rescan budget when it is free. Every caller outside the panel that forces
 *  a scan must take it too, or it would amplify full scans the same way. A user's explicit request
 *  takes it even when spent, as the panel's Refresh does, so no automatic rescan follows it. */
export function claimAiVaultForcedRescan(userRequested = false): boolean {
  const now = Date.now()
  if (!userRequested && lastForcedRescanAt + FORCED_RESCAN_MIN_INTERVAL_MS > now) {
    return false
  }
  lastForcedRescanAt = now
  return true
}

export function aiVaultForcedRescanDelay(): number {
  return lastForcedRescanAt + FORCED_RESCAN_MIN_INTERVAL_MS - Date.now()
}

export function resetAiVaultForcedRescanBudgetForTest(): void {
  lastForcedRescanAt = 0
}

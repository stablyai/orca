// STA-1282 gate #9 bookkeeping: per-tab teardown-invalidation generations and
// the evicting signal the pane lifecycle consumes during React cleanup to
// choose park() over detach()/destroy() (gate #1). A teardown queued for
// generation N must become a no-op once the pane re-warms or a remount claims
// it — both bump the generation.

const generationByTab = new Map<string, number>()
const evictingTabIds = new Set<string>()

export function teardownGeneration(tabId: string): number {
  return generationByTab.get(tabId) ?? 0
}

export function bumpTeardownGeneration(tabId: string): void {
  generationByTab.set(tabId, (generationByTab.get(tabId) ?? 0) + 1)
}

/** Raised just BEFORE the unmounting store write so the pane lifecycle's
 *  cleanup reads it and parks instead of detaching/destroying. */
export function markTabEvicting(tabId: string): void {
  evictingTabIds.add(tabId)
}

/** Clear a stale eviction signal without touching the generation (re-warm:
 *  a teardown that fired while the tab was already re-revealed must not make
 *  a later close/reparent look like an eviction). */
export function clearTabEvictingSignal(tabId: string): void {
  evictingTabIds.delete(tabId)
}

/** Drop all per-tab signal state (tab closed — leave no session residue). */
export function pruneTabEvictionSignal(tabId: string): void {
  generationByTab.delete(tabId)
  evictingTabIds.delete(tabId)
}

/** Read-and-clear the eviction signal for a tab. The pane lifecycle calls this
 *  during React cleanup to choose park() over detach()/destroy() (gate #1). */
export function consumeTerminalPaneEviction(tabId: string): boolean {
  const wasEvicting = evictingTabIds.has(tabId)
  evictingTabIds.delete(tabId)
  return wasEvicting
}

// Test-only reset.
export function __resetTerminalPaneEvictionSignalForTest(): void {
  generationByTab.clear()
  evictingTabIds.clear()
}

import type { SessionTabsPublicationEpochHistory } from '../web-session-tabs-sync/state'
import type { StructuredSessionTabPublicationVersion } from '../local-structured-session-tab-retirement'

// Track publisher generation, accepted per-worktree publications and one-shot restore. Every async entry rechecks its starting generation so reset fences in-flight responses.
let syncGeneration = 0
let restorePromise: Promise<void> | null = null

export const localStructuredSessionVersionByWorktree = new Map<
  string,
  StructuredSessionTabPublicationVersion
>()
export const localStructuredSessionEpochHistoryByWorktree = new Map<
  string,
  SessionTabsPublicationEpochHistory
>()

export function localStructuredSessionGeneration(): number {
  return syncGeneration
}

export function isCurrentLocalStructuredSessionGeneration(generation: number): boolean {
  return generation === syncGeneration
}

/** Latch the startup restore, releasing it on failure so a retry can re-run it. */
export function latchLocalStructuredSessionRestore(start: () => Promise<void>): Promise<void> {
  restorePromise ??= start().catch((error: unknown) => {
    restorePromise = null
    throw error
  })
  return restorePromise
}

export function resetLocalStructuredSessionVersionForTests(): void {
  syncGeneration += 1
  localStructuredSessionVersionByWorktree.clear()
  localStructuredSessionEpochHistoryByWorktree.clear()
}

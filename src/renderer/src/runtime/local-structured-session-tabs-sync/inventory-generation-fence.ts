import type { SessionTabsPublicationEpochHistory } from '../web-session-tabs-sync/state'
import type { StructuredSessionTabPublicationVersion } from '../local-structured-session-tab-retirement'

// Which publisher instance the renderer is listening to, which publication it
// already accepted per worktree, and the one-shot startup restore. A response in
// flight for a superseded instance must never reach the mirror, so every async
// entry point carries the generation it was started under and re-checks it.
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

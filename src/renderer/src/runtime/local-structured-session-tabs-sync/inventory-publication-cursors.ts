import type { SessionTabsPublicationEpochHistory } from '../web-session-tabs-sync/state'
import type { StructuredSessionTabPublicationVersion } from '../local-structured-session-tab-retirement'

// Which publication the renderer already accepted per worktree, and the one-shot startup restore.
let restorePromise: Promise<void> | null = null

export const localStructuredSessionVersionByWorktree = new Map<
  string,
  StructuredSessionTabPublicationVersion
>()
export const localStructuredSessionEpochHistoryByWorktree = new Map<
  string,
  SessionTabsPublicationEpochHistory
>()

/** Latch the startup restore, releasing it on failure so a retry can re-run it. */
export function latchLocalStructuredSessionRestore(start: () => Promise<void>): Promise<void> {
  restorePromise ??= start().catch((error: unknown) => {
    restorePromise = null
    throw error
  })
  return restorePromise
}

export function resetLocalStructuredSessionVersionForTests(): void {
  restorePromise = null
  localStructuredSessionVersionByWorktree.clear()
  localStructuredSessionEpochHistoryByWorktree.clear()
}

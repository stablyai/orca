import type { StateCreator } from 'zustand'
import type { RateLimitWatcherSnapshot } from '../../../../shared/rate-limit-watcher-types'
import type { AppState } from '../types'

// Main owns the armed set; the renderer mirrors it and sends toggles straight to
// the preload API, which answers with the new set.
export type RateLimitWatcherSlice = {
  rateLimitWatcherTabIds: string[]
  /** Bumped by every authoritative write. A mount-time hydrate captures it before
   *  its IPC round-trip and is discarded if a toggle landed meanwhile — otherwise
   *  the older set wins, the checkbox flips back, and the next click re-sends the
   *  enable it already sent instead of disabling. */
  rateLimitWatcherRevision: number
  setRateLimitWatcherSnapshot: (snapshot: RateLimitWatcherSnapshot) => void
  /** Apply a one-shot `get()` result, unless something newer already landed. */
  hydrateRateLimitWatcherSnapshot: (snapshot: RateLimitWatcherSnapshot, revision: number) => void
  toggleRateLimitWatcher: (tabId: string, enabled: boolean) => Promise<void>
}

export const createRateLimitWatcherSlice: StateCreator<AppState, [], [], RateLimitWatcherSlice> = (
  set
) => ({
  rateLimitWatcherTabIds: [],
  rateLimitWatcherRevision: 0,
  setRateLimitWatcherSnapshot: (snapshot) =>
    set((state) => ({
      rateLimitWatcherTabIds: snapshot.tabIds,
      rateLimitWatcherRevision: (state.rateLimitWatcherRevision ?? 0) + 1
    })),
  hydrateRateLimitWatcherSnapshot: (snapshot, revision) =>
    set((state) =>
      (state.rateLimitWatcherRevision ?? 0) === revision
        ? { rateLimitWatcherTabIds: snapshot.tabIds, rateLimitWatcherRevision: revision + 1 }
        : {}
    ),
  toggleRateLimitWatcher: async (tabId, enabled) => {
    const snapshot = await window.api.rateLimitWatcher?.set?.(tabId, enabled)
    if (snapshot) {
      // Through the counted setter: main answered with the definitive set, so
      // any hydrate still in flight is now stale.
      set((state) => ({
        rateLimitWatcherTabIds: snapshot.tabIds,
        rateLimitWatcherRevision: (state.rateLimitWatcherRevision ?? 0) + 1
      }))
    }
  }
})

export function selectIsRateLimitWatcherArmed(
  state: Pick<RateLimitWatcherSlice, 'rateLimitWatcherTabIds'>,
  tabId: string
): boolean {
  return (state.rateLimitWatcherTabIds ?? []).includes(tabId)
}

import type { StoreApi } from 'zustand'
import type { AppState } from '../types'

const SAVE_WINDOW_MS = 1000
const persistedStores = new WeakSet<object>()

/**
 * Mirrors the PR and issue caches to main whenever either changes, so every writer is covered.
 * Main derives the sidebar's PR facts from this copy. A fixed window, not a resettable debounce:
 * a steady stream of results still reaches main within a second. Once per store.
 */
export function persistGitHubCacheChanges(
  store: Pick<StoreApi<AppState>, 'getState' | 'subscribe'>
): void {
  if (persistedStores.has(store)) {
    return
  }
  persistedStores.add(store)
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    timer ??= setTimeout(() => {
      timer = null
      const { prCache, issueCache } = store.getState()
      window.api.cache.setGitHub({ cache: { pr: prCache, issue: issueCache } })
    }, SAVE_WINDOW_MS)
  }
  store.subscribe((state, previous) => {
    if (state.prCache !== previous.prCache || state.issueCache !== previous.issueCache) {
      schedule()
    }
  })
}

import type { StoreApi } from 'zustand'
import type { AppState } from '../types'

const SAVE_WINDOW_MS = 1000
const persistedStores = new WeakSet<object>()

/** Mirror both caches to main for sidebar PR facts. Use a fixed one-second window per store so steady results cannot postpone writes indefinitely. */
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

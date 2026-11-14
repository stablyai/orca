/** Install on inner creator API before create copies subscribe to bound hook; patching the hook misses React subscribers. Cost occurs only on subscribe/unsubscribe, never per state write. */

type StoreListenerCensusApi<T> = {
  subscribe: (listener: (state: T, previousState: T) => void) => () => void
}

let liveListenerCount: number | null = null

export function readStoreListenerCount(): number | null {
  return liveListenerCount
}

/** Call once from inside the store's state creator, passing its `api` argument. */
export function installStoreListenerCensus<T>(api: StoreListenerCensusApi<T>): void {
  try {
    const originalSubscribe = api.subscribe
    if (typeof originalSubscribe !== 'function') {
      return
    }
    let live = 0
    liveListenerCount = 0
    api.subscribe = (listener) => {
      live += 1
      liveListenerCount = live
      const unsubscribe = originalSubscribe(listener)
      let released = false
      return () => {
        // Why: React can call the same cleanup twice; only the first release counts.
        if (!released) {
          released = true
          live -= 1
          liveListenerCount = live
        }
        unsubscribe()
      }
    }
  } catch {
    liveListenerCount = null
  }
}

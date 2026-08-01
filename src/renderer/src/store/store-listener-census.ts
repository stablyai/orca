import {
  registerRendererMemoryProfileContributor,
  type RendererMemoryProfileCounts
} from '../lib/renderer-memory-profile'

/**
 * Live count of zustand store subscribers, for the typing-latency census.
 *
 * Why this lives in the store and not in the probe: zustand's create() builds the
 * inner api first, then copies `subscribe` onto the bound hook. useStore() reads
 * the INNER api.subscribe, so patching the hook's copy after the fact counts only
 * imperative useAppStore.subscribe() callers (16 sites) and silently misses every
 * React hook subscription (~2.2k sites) — exactly the ones that scale with agent
 * rows. The inner api is only reachable as the state creator's third argument.
 *
 * Cost is per-subscribe (component mount), never per-setState: zustand notifies by
 * iterating its listener Set directly, so this never touches the keystroke path.
 */

type StoreListenerCensusApi<T> = {
  subscribe: (listener: (state: T, previousState: T) => void) => () => void
}

let liveListenerCount: number | null = null

// Why: an OOM report cannot otherwise separate a subscriber leak (components that
// never unmount) from a data leak, and the count is already being computed.
registerRendererMemoryProfileContributor('storeSubscribers', (): RendererMemoryProfileCounts => {
  const live = readStoreListenerCount()
  return live === null ? {} : { live }
})

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

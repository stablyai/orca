import { useEffect } from 'react'
import { create } from 'zustand'
import type { PluginsApi } from '../../../preload/api/plugin-host-api'

type PluginContentListState<Entry> = {
  entries: Entry[]
  loaded: boolean
  fetchEntries: () => Promise<void>
}

// Share startup discovery only within a bound; wedged requests must not pin ensureLoaded consumers to built-ins forever. Later consumers retry independently (main/git/coalesced-probe.ts).
const STARTUP_REQUEST_JOIN_WINDOW_MS = 10_000

/** One renderer list of a plugin content family, refetched whenever plugin content changes. */
export function createPluginContentListStore<Entry>(options: {
  /** Plural noun for logs, e.g. "language packs". */
  kind: string
  list: (api: PluginsApi) => (() => Promise<unknown>) | undefined
  isEntry: (value: unknown) => value is Entry
}) {
  let requestGeneration = 0
  let latestRequestStartedAt: number | null = null
  let changeSubscriptionStarted = false

  const useStore = create<PluginContentListState<Entry>>()((set) => ({
    entries: [],
    loaded: false,
    fetchEntries: async () => {
      const generation = ++requestGeneration
      latestRequestStartedAt = Date.now()
      const api = window.api?.plugins
      const list = api ? options.list(api) : undefined
      if (!list) {
        if (generation === requestGeneration) {
          latestRequestStartedAt = null
          set({ entries: [], loaded: true })
        }
        return
      }
      try {
        const response = await list()
        const entries = Array.isArray(response) ? response.filter(options.isEntry) : []
        // Why: a non-array response and a rejected member are different upstream bugs; keep them distinguishable in the log.
        if (!Array.isArray(response)) {
          console.warn(`[plugins] Ignoring non-array ${options.kind} list (${typeof response})`)
        } else if (entries.length !== response.length) {
          console.warn(
            `[plugins] Ignoring ${response.length - entries.length} of ${response.length} malformed ${options.kind}`
          )
        }
        if (generation === requestGeneration) {
          set({ entries, loaded: true })
        }
      } catch {
        if (generation === requestGeneration) {
          set({ entries: [], loaded: true })
        }
      } finally {
        if (generation === requestGeneration) {
          latestRequestStartedAt = null
        }
      }
    }
  }))

  function ensureLoaded(): void {
    const state = useStore.getState()
    const joinable =
      latestRequestStartedAt !== null &&
      Date.now() - latestRequestStartedAt < STARTUP_REQUEST_JOIN_WINDOW_MS
    if (!state.loaded && !joinable) {
      void state.fetchEntries()
    }
    if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
      changeSubscriptionStarted = true
      window.api.plugins.onChanged((event) => {
        if (event?.contentPacksChanged ?? true) {
          void useStore.getState().fetchEntries()
        }
      })
    }
  }

  function useEntries(): Entry[] {
    const entries = useStore((state) => state.entries)
    useEffect(() => ensureLoaded(), [])
    return entries
  }

  return { useStore, ensureLoaded, useEntries }
}

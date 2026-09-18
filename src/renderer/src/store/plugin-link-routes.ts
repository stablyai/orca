import { create } from 'zustand'
import type { NormalizedLinkRoute } from '../../../shared/plugins/plugin-link-route-matching'

// Approved, conflict-filtered, ranked route table. Read synchronously at link-click time via
// getState(), so it must already be populated before the first click — see
// ensurePluginLinkRoutesLoaded's mount owner. An empty table means "no routes", which is exactly
// today's behavior, so every failure here degrades to the pre-feature path rather than blocking.

type PluginLinkRouteState = {
  routes: NormalizedLinkRoute[]
  loaded: boolean
  fetchRoutes: () => Promise<void>
}

function isNormalizedLinkRoute(value: unknown): value is NormalizedLinkRoute {
  if (typeof value !== 'object' || value === null || !('pattern' in value)) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed to a non-null object above; every field is typeof-checked before use.
  const { pattern, destination, pluginKey, index } = value as Record<string, unknown>
  if (typeof pattern !== 'object' || pattern === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed to a non-null object on the line above.
  const shape = pattern as Record<string, unknown>
  const patternIsWellFormed =
    shape.kind === 'exact'
      ? typeof shape.host === 'string'
      : (shape.kind === 'label' || shape.kind === 'midlabel') && typeof shape.tail === 'string'
  return (
    patternIsWellFormed &&
    (destination === 'orca-browser' || destination === 'system-browser') &&
    typeof pluginKey === 'string' &&
    typeof index === 'number'
  )
}

let requestGeneration = 0
let changeSubscriptionStarted = false

export const usePluginLinkRouteStore = create<PluginLinkRouteState>()((set) => ({
  routes: [],
  loaded: false,
  fetchRoutes: async () => {
    const generation = ++requestGeneration
    const api = window.api?.plugins
    if (!api?.listLinkRoutes) {
      if (generation === requestGeneration) {
        set({ routes: [], loaded: true })
      }
      return
    }
    try {
      const response = await api.listLinkRoutes()
      const routes = Array.isArray(response) ? response.filter(isNormalizedLinkRoute) : []
      // Why: a non-array response and a rejected member are different upstream bugs; keep them distinguishable in the log.
      if (!Array.isArray(response)) {
        console.warn(`[plugins] Ignoring non-array link-route list (${typeof response})`)
      } else if (routes.length !== response.length) {
        console.warn(
          `[plugins] Ignoring ${response.length - routes.length} of ${response.length} malformed link routes`
        )
      }
      if (generation === requestGeneration) {
        set({ routes, loaded: true })
      }
    } catch (error) {
      // Fail soft, but not silently: a broken handler would otherwise latch an empty table forever
      // and look exactly like "this user has no plugins with routes".
      console.warn('[plugins] Failed to load link routes', error)
      if (generation === requestGeneration) {
        set({ routes: [], loaded: true })
      }
    }
  }
}))

export function ensurePluginLinkRoutesLoaded(): void {
  const state = usePluginLinkRouteStore.getState()
  if (!state.loaded) {
    void state.fetchRoutes()
  }
  if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
    changeSubscriptionStarted = true
    // Unsubscribe deliberately discarded: this is a process-lifetime subscription, and the guard
    // above is what keeps StrictMode's double-mount from registering two IPC listeners.
    window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        void usePluginLinkRouteStore.getState().fetchRoutes()
      }
    })
  }
}

/** Synchronous read for the click path. Returns an empty table until the first fetch resolves. */
export function getPluginLinkRoutes(): readonly NormalizedLinkRoute[] {
  return usePluginLinkRouteStore.getState().routes
}

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/types'

export type DetectedAgentsSlice = {
  detectedAgentIds: TuiAgent[] | null
  isDetectingAgents: boolean
  isRefreshingAgents: boolean
  /** Runs `preflight.detectAgents` once per session. Subsequent callers reuse
   *  the in-flight promise so every surface sees the same result. */
  ensureDetectedAgents: () => Promise<TuiAgent[]>
  /** Re-runs `preflight.refreshAgents` (re-reads shell PATH). Concurrent callers
   *  receive the same pending promise; store fields update once on resolve so
   *  every subscribed surface re-renders in the same tick. */
  refreshDetectedAgents: () => Promise<TuiAgent[]>
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
let detectPromise: Promise<TuiAgent[]> | null = null
let refreshPromise: Promise<TuiAgent[]> | null = null

export const createDetectedAgentsSlice: StateCreator<AppState, [], [], DetectedAgentsSlice> = (
  set,
  get
) => ({
  detectedAgentIds: null,
  isDetectingAgents: false,
  isRefreshingAgents: false,

  ensureDetectedAgents: () => {
    const existing = get().detectedAgentIds
    if (existing) {
      return Promise.resolve(existing)
    }
    if (detectPromise) {
      return detectPromise
    }
    set({ isDetectingAgents: true })
    const pending = window.api.preflight
      .detectAgents()
      .then((ids) => {
        const typed = ids as TuiAgent[]
        set({ detectedAgentIds: typed, isDetectingAgents: false })
        return typed
      })
      .catch(() => {
        // Why: allow a retry on the next call if detection blew up (IPC timeout
        // during cold start). Do not cache the failure.
        detectPromise = null
        set({ isDetectingAgents: false })
        return [] as TuiAgent[]
      })
    detectPromise = pending
    return pending
  },

  refreshDetectedAgents: () => {
    if (refreshPromise) {
      return refreshPromise
    }
    set({ isRefreshingAgents: true })
    const pending = window.api.preflight
      .refreshAgents()
      .then((result) => {
        const typed = result.agents as TuiAgent[]
        set({ detectedAgentIds: typed, isRefreshingAgents: false })
        // Why: once refresh has run, treat its result as the current detection
        // snapshot so `ensureDetectedAgents` short-circuits.
        detectPromise = Promise.resolve(typed)
        return typed
      })
      .catch(() => {
        set({ isRefreshingAgents: false })
        return get().detectedAgentIds ?? []
      })
      .finally(() => {
        refreshPromise = null
      })
    refreshPromise = pending
    return pending
  }
})

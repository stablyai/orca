import type { AppState } from '../types'
import type { PathSource, ShellHydrationFailureReason, TuiAgent } from '../../../../shared/types'
import {
  getLocalAgentPreflightContext,
  getLocalRepoAgentPreflightContext,
  localPreflightContextKey
} from '@/lib/local-preflight-context'

export type LocalDetectedAgentTarget = { repoId: string } | { worktreeId: string | null }

export type LocalDetectedAgentsSlice = {
  detectedAgentIds: TuiAgent[] | null
  isDetectingAgents: boolean
  isRefreshingAgents: boolean
  /** Telemetry classification of the most recent refreshAgents() run. `null`
   *  before the first refresh resolves. Read by the wizard at agent-pick time
   *  to attach `path_source` / `path_failure_reason` to `onboarding_agent_picked`
   *  — see docs/agent-on-path-detection.md. */
  pathSource: PathSource | null
  pathFailureReason: ShellHydrationFailureReason | null
  /** Runs `preflight.detectAgents` once per session. Subsequent callers reuse
   *  the in-flight promise so every surface sees the same result. */
  ensureDetectedAgents: (target?: LocalDetectedAgentTarget) => Promise<TuiAgent[]>
  /** Re-runs `preflight.refreshAgents` (re-reads shell PATH). Concurrent callers
   *  receive the same pending promise; store fields update once on resolve so
   *  every subscribed surface re-renders in the same tick. */
  refreshDetectedAgents: () => Promise<TuiAgent[]>
  clearLocalDetectedAgents: () => void
}

// Why: these are module-scoped (not in the store) so concurrent local probes
// can be deduplicated without storing a Promise in Zustand state.
const detectPromises = new Map<string, Promise<TuiAgent[]>>()
let refreshPromise: { key: string; promise: Promise<TuiAgent[]> } | null = null
let detectedContextKey: string | null = null
let localDetectionGeneration = 0
let latestLocalDetectionRequest = 0

type SetLocalDetectedAgentsState = (partial: Partial<LocalDetectedAgentsSlice>) => void

export function createLocalDetectedAgentsState(
  set: SetLocalDetectedAgentsState,
  get: () => AppState
): LocalDetectedAgentsSlice {
  return {
    detectedAgentIds: null,
    isDetectingAgents: false,
    isRefreshingAgents: false,
    pathSource: null,
    pathFailureReason: null,

    ensureDetectedAgents: (target) => {
      const context = target
        ? 'repoId' in target
          ? getLocalRepoAgentPreflightContext(get(), target.repoId)
          : getLocalAgentPreflightContext(get(), undefined, undefined, target.worktreeId)
        : getLocalAgentPreflightContext(get())
      const contextKey = localPreflightContextKey(context)
      // Worktree-scoped probes serve one continuation/direct-launch request.
      // They must not replace the composer-visible repository snapshot.
      const shouldStoreResult = !target || 'repoId' in target
      const promiseKey = `${contextKey}\u0000${shouldStoreResult ? 'shared' : 'ephemeral'}`
      const existing = get().detectedAgentIds
      if (shouldStoreResult && existing && detectedContextKey === contextKey) {
        return Promise.resolve(existing)
      }
      const inFlight = detectPromises.get(promiseKey)
      if (inFlight) {
        return inFlight
      }
      const contextChanged = detectedContextKey !== contextKey
      if (shouldStoreResult) {
        set({
          detectedAgentIds: contextChanged ? null : get().detectedAgentIds,
          isDetectingAgents: true,
          isRefreshingAgents: false
        })
      }
      const requestGeneration = localDetectionGeneration
      const requestId = shouldStoreResult
        ? ++latestLocalDetectionRequest
        : latestLocalDetectionRequest
      let pending: Promise<TuiAgent[]>
      pending = window.api.preflight
        .detectAgents(context ?? undefined)
        .then((ids) => {
          const typed = ids as TuiAgent[]
          if (
            shouldStoreResult &&
            requestGeneration === localDetectionGeneration &&
            requestId === latestLocalDetectionRequest &&
            detectPromises.get(promiseKey) === pending
          ) {
            set({ detectedAgentIds: typed, isDetectingAgents: false })
            detectedContextKey = contextKey
          }
          return typed
        })
        .catch(() => {
          if (
            shouldStoreResult &&
            requestGeneration === localDetectionGeneration &&
            requestId === latestLocalDetectionRequest &&
            detectPromises.get(promiseKey) === pending
          ) {
            set({
              detectedAgentIds: contextChanged ? [] : get().detectedAgentIds,
              isDetectingAgents: false
            })
          }
          return [] as TuiAgent[]
        })
        .finally(() => {
          if (detectPromises.get(promiseKey) === pending) {
            detectPromises.delete(promiseKey)
          }
        })
      detectPromises.set(promiseKey, pending)
      return pending
    },

    refreshDetectedAgents: () => {
      const context = getLocalAgentPreflightContext(get())
      const contextKey = localPreflightContextKey(context)
      if (refreshPromise?.key === contextKey) {
        return refreshPromise.promise
      }
      const contextChanged = detectedContextKey !== contextKey
      set({
        detectedAgentIds: contextChanged ? null : get().detectedAgentIds,
        isDetectingAgents: false,
        isRefreshingAgents: true
      })
      const requestGeneration = localDetectionGeneration
      const requestId = ++latestLocalDetectionRequest
      let pending: Promise<TuiAgent[]>
      pending = window.api.preflight
        .refreshAgents(context)
        .then((result) => {
          const typed = result.agents as TuiAgent[]
          if (
            requestGeneration === localDetectionGeneration &&
            requestId === latestLocalDetectionRequest &&
            refreshPromise?.promise === pending
          ) {
            set({
              detectedAgentIds: typed,
              isRefreshingAgents: false,
              pathSource: result.pathSource,
              pathFailureReason: result.pathFailureReason
            })
            // Why: once refresh has run, treat its result as the current detection
            // snapshot so `ensureDetectedAgents` short-circuits.
            detectedContextKey = contextKey
          }
          return typed
        })
        .catch(() => {
          const fallback = contextChanged ? [] : (get().detectedAgentIds ?? [])
          if (
            requestGeneration === localDetectionGeneration &&
            requestId === latestLocalDetectionRequest &&
            refreshPromise?.promise === pending
          ) {
            set({
              detectedAgentIds: fallback,
              isRefreshingAgents: false
            })
          }
          return fallback
        })
        .finally(() => {
          if (refreshPromise?.promise === pending) {
            refreshPromise = null
          }
        })
      refreshPromise = { key: contextKey, promise: pending }
      return pending
    },

    clearLocalDetectedAgents: () => {
      localDetectionGeneration += 1
      latestLocalDetectionRequest += 1
      detectPromises.clear()
      refreshPromise = null
      detectedContextKey = null
      set({
        detectedAgentIds: null,
        isDetectingAgents: false,
        isRefreshingAgents: false,
        pathSource: null,
        pathFailureReason: null
      })
    }
  }
}

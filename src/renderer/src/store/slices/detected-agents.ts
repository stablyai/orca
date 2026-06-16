import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PathSource, ShellHydrationFailureReason, TuiAgent } from '../../../../shared/types'
import {
  getLocalAgentPreflightContext,
  localPreflightContextKey
} from '@/lib/local-preflight-context'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export type DetectedAgentsSlice = {
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
  ensureDetectedAgents: () => Promise<TuiAgent[]>
  /** Re-runs `preflight.refreshAgents` (re-reads shell PATH). Concurrent callers
   *  receive the same pending promise; store fields update once on resolve so
   *  every subscribed surface re-renders in the same tick. */
  refreshDetectedAgents: () => Promise<TuiAgent[]>
  clearLocalDetectedAgents: () => void

  // Why: remote worktrees need per-connection agent detection. The local
  // detectedAgentIds field is connection-unaware, so remote state lives in a
  // separate map keyed by SSH connectionId.
  remoteDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRemoteAgents: Record<string, boolean>
  ensureRemoteDetectedAgents: (connectionId: string) => Promise<TuiAgent[]>
  clearRemoteDetectedAgents: (connectionId: string) => void

  // Why: remote runtime hosts are not SSH connections, but their tab-bar
  // launch menu still has to probe the host where the workspace actually runs.
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRuntimeAgents: Record<string, boolean>
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
  clearRuntimeDetectedAgents: (environmentId: string) => void
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
let detectPromise: { key: string; promise: Promise<TuiAgent[]> } | null = null
let refreshPromise: { key: string; promise: Promise<TuiAgent[]> } | null = null
let detectedContextKey: string | null = null
let localDetectionGeneration = 0
const remoteDetectPromises = new Map<string, Promise<TuiAgent[]>>()
const runtimeDetectPromises = new Map<string, Promise<TuiAgent[]>>()

export function _getRemoteDetectPromiseCountForTest(): number {
  return remoteDetectPromises.size
}

export function _getRuntimeDetectPromiseCountForTest(): number {
  return runtimeDetectPromises.size
}

export const createDetectedAgentsSlice: StateCreator<AppState, [], [], DetectedAgentsSlice> = (
  set,
  get
) => ({
  detectedAgentIds: null,
  isDetectingAgents: false,
  isRefreshingAgents: false,
  pathSource: null,
  pathFailureReason: null,

  ensureDetectedAgents: () => {
    const context = getLocalAgentPreflightContext(get())
    const contextKey = localPreflightContextKey(context)
    const existing = get().detectedAgentIds
    if (existing && detectedContextKey === contextKey) {
      return Promise.resolve(existing)
    }
    if (detectPromise?.key === contextKey) {
      return detectPromise.promise
    }
    const contextChanged = detectedContextKey !== contextKey
    set({
      detectedAgentIds: contextChanged ? null : get().detectedAgentIds,
      isDetectingAgents: true
    })
    const requestGeneration = localDetectionGeneration
    const pending = window.api.preflight
      .detectAgents(context)
      .then((ids) => {
        const typed = ids as TuiAgent[]
        if (requestGeneration === localDetectionGeneration) {
          set({ detectedAgentIds: typed, isDetectingAgents: false })
          detectedContextKey = contextKey
        }
        return typed
      })
      .catch(() => {
        // Why: allow a retry on the next call if detection blew up (IPC timeout
        // during cold start). Do not cache the failure or show stale context.
        if (requestGeneration === localDetectionGeneration) {
          detectPromise = null
          set({
            detectedAgentIds: contextChanged ? [] : get().detectedAgentIds,
            isDetectingAgents: false
          })
        }
        return [] as TuiAgent[]
      })
    detectPromise = { key: contextKey, promise: pending }
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
      isRefreshingAgents: true
    })
    const requestGeneration = localDetectionGeneration
    const pending = window.api.preflight
      .refreshAgents(context)
      .then((result) => {
        const typed = result.agents as TuiAgent[]
        if (requestGeneration === localDetectionGeneration) {
          set({
            detectedAgentIds: typed,
            isRefreshingAgents: false,
            pathSource: result.pathSource,
            pathFailureReason: result.pathFailureReason
          })
          // Why: once refresh has run, treat its result as the current detection
          // snapshot so `ensureDetectedAgents` short-circuits.
          detectedContextKey = contextKey
          detectPromise = { key: contextKey, promise: Promise.resolve(typed) }
        }
        return typed
      })
      .catch(() => {
        const fallback = contextChanged ? [] : (get().detectedAgentIds ?? [])
        if (requestGeneration === localDetectionGeneration) {
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
    detectPromise = null
    refreshPromise = null
    detectedContextKey = null
    set({
      detectedAgentIds: null,
      isDetectingAgents: false,
      isRefreshingAgents: false,
      pathSource: null,
      pathFailureReason: null
    })
  },

  remoteDetectedAgentIds: {},
  isDetectingRemoteAgents: {},
  runtimeDetectedAgentIds: {},
  isDetectingRuntimeAgents: {},

  ensureRemoteDetectedAgents: (connectionId: string) => {
    const existing = get().remoteDetectedAgentIds[connectionId]
    if (existing) {
      return Promise.resolve(existing)
    }
    const inflight = remoteDetectPromises.get(connectionId)
    if (inflight) {
      return inflight
    }

    set((s) => ({
      isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: true }
    }))

    const pending = window.api.preflight
      .detectRemoteAgents({ connectionId })
      .then((ids) => {
        const typed = ids as TuiAgent[]
        set((s) => ({
          remoteDetectedAgentIds: { ...s.remoteDetectedAgentIds, [connectionId]: typed },
          isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: false }
        }))
        return typed
      })
      .catch(() => {
        // Why: allow retry on next call (SSH may reconnect). Do not cache failure.
        set((s) => ({
          isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: false }
        }))
        return [] as TuiAgent[]
      })
      .finally(() => {
        // Why: this map is only for in-flight dedupe. Successful results live
        // in remoteDetectedAgentIds, so keeping resolved promises duplicates
        // one entry per SSH connection for the rest of the renderer session.
        if (remoteDetectPromises.get(connectionId) === pending) {
          remoteDetectPromises.delete(connectionId)
        }
      })

    remoteDetectPromises.set(connectionId, pending)
    return pending
  },

  // Why: the remote agent list is tied to a live SSH connection. On disconnect
  // the relay is gone, so clear both the cached result and the deduplication
  // promise. When the user reconnects and opens the quick-launch menu,
  // ensureRemoteDetectedAgents will re-detect against the new relay.
  clearRemoteDetectedAgents: (connectionId: string) => {
    remoteDetectPromises.delete(connectionId)
    set((s) => {
      const { [connectionId]: _, ...restAgents } = s.remoteDetectedAgentIds
      const { [connectionId]: __, ...restLoading } = s.isDetectingRemoteAgents
      return { remoteDetectedAgentIds: restAgents, isDetectingRemoteAgents: restLoading }
    })
  },

  ensureRuntimeDetectedAgents: (environmentId: string) => {
    const existing = get().runtimeDetectedAgentIds[environmentId]
    if (existing) {
      return Promise.resolve(existing)
    }
    const inflight = runtimeDetectPromises.get(environmentId)
    if (inflight) {
      return inflight
    }

    set((s) => ({
      isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [environmentId]: true }
    }))

    const pending = callRuntimeRpc<TuiAgent[]>(
      { kind: 'environment', environmentId },
      'preflight.detectAgents'
    )
      .then((ids) => {
        const typed = ids as TuiAgent[]
        set((s) => ({
          runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [environmentId]: typed },
          isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [environmentId]: false }
        }))
        return typed
      })
      .catch(() => {
        // Why: a remote runtime may be disconnected or version-incompatible.
        // Keep the menu retryable instead of pinning a failed probe forever.
        set((s) => ({
          isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [environmentId]: false }
        }))
        return [] as TuiAgent[]
      })
      .finally(() => {
        if (runtimeDetectPromises.get(environmentId) === pending) {
          runtimeDetectPromises.delete(environmentId)
        }
      })

    runtimeDetectPromises.set(environmentId, pending)
    return pending
  },

  clearRuntimeDetectedAgents: (environmentId: string) => {
    runtimeDetectPromises.delete(environmentId)
    set((s) => {
      const { [environmentId]: _, ...restAgents } = s.runtimeDetectedAgentIds
      const { [environmentId]: __, ...restLoading } = s.isDetectingRuntimeAgents
      return { runtimeDetectedAgentIds: restAgents, isDetectingRuntimeAgents: restLoading }
    })
  }
})

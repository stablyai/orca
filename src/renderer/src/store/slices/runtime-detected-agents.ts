import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/types'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'

// Why: remote runtime hosts are not SSH connections, but their launch surfaces
// (tab bar, quick launch, Settings → Agents under an Active Server) still have
// to probe the host where the workspace actually runs.
export type RuntimeDetectedAgentsSlice = {
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRuntimeAgents: Record<string, boolean>
  isRefreshingRuntimeAgents: Record<string, boolean>
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
  /** Forces a re-detect on the runtime host via `preflight.refreshAgents`
   *  (login-shell PATH re-read), falling back to `preflight.detectAgents` for
   *  servers that predate the refresh RPC. */
  refreshRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
  clearRuntimeDetectedAgents: (environmentId: string) => void
  /** Drops runtime detected-agent caches for environments not in the kept set.
   *  Wired into setRuntimeEnvironments so removed environments don't leak their
   *  detected-agent entries for the renderer session. */
  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => void
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
const runtimeDetectPromises = new Map<string, Promise<TuiAgent[]>>()
const runtimeRefreshPromises = new Map<string, Promise<TuiAgent[]>>()

function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

export function _getRuntimeDetectPromiseCountForTest(): number {
  return runtimeDetectPromises.size
}

export function _getRuntimeRefreshPromiseCountForTest(): number {
  return runtimeRefreshPromises.size
}

export const createRuntimeDetectedAgentsSlice: StateCreator<
  AppState,
  [],
  [],
  RuntimeDetectedAgentsSlice
> = (set, get) => ({
  runtimeDetectedAgentIds: {},
  isDetectingRuntimeAgents: {},
  isRefreshingRuntimeAgents: {},

  ensureRuntimeDetectedAgents: (environmentId: string) => {
    const inflightRefresh = runtimeRefreshPromises.get(environmentId)
    if (inflightRefresh) {
      return inflightRefresh
    }
    const existing = get().runtimeDetectedAgentIds[environmentId]
    // Why: an empty result ([]) is truthy, so a prior "no agents found" detection
    // must not be treated as cached — re-detect so a later install / PATH fix is
    // picked up without a reconnect. Non-empty results still short-circuit.
    if (existing?.length) {
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
        // Why: skip committing if the environment was removed (retained out)
        // while the detect was in flight — otherwise it re-adds a stale entry
        // that retainRuntimeDetectedAgents just pruned.
        if (runtimeDetectPromises.get(environmentId) === pending) {
          set((s) => ({
            runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [environmentId]: typed },
            isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [environmentId]: false }
          }))
        }
        return typed
      })
      .catch(() => {
        // Why: a remote runtime may be disconnected or version-incompatible.
        // Keep the menu retryable instead of pinning a failed probe forever.
        // Same in-flight guard as the .then() above: if the environment was
        // retained out mid-detect, don't re-add the isDetecting entry that
        // retainRuntimeDetectedAgents just pruned (and don't clobber a freshly
        // started detect's spinner).
        if (runtimeDetectPromises.get(environmentId) === pending) {
          set((s) => ({
            isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [environmentId]: false }
          }))
        }
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

  refreshRuntimeDetectedAgents: (environmentId: string) => {
    const inflight = runtimeRefreshPromises.get(environmentId)
    if (inflight) {
      return inflight
    }

    // Why: a refresh is newer and authoritative; detach an older detect so its
    // late result cannot overwrite the freshly hydrated PATH result.
    runtimeDetectPromises.delete(environmentId)
    set((s) => ({
      isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [environmentId]: true }
    }))

    const pending = callRuntimeRpc<{ agents: TuiAgent[] }>(
      { kind: 'environment', environmentId },
      'preflight.refreshAgents'
    )
      .then((result) => result.agents)
      .catch((error) => {
        if (!isRuntimeMethodNotFoundError(error)) {
          throw error
        }
        // Why: only older servers need the fallback; retrying disconnects and
        // runtime failures doubles remote work without any chance of recovery.
        return callRuntimeRpc<TuiAgent[]>(
          { kind: 'environment', environmentId },
          'preflight.detectAgents'
        )
      })
      .then((ids) => {
        const typed = ids as TuiAgent[]
        // Why: same guard as ensureRuntimeDetectedAgents — if the environment
        // was retained out mid-refresh, don't re-add a pruned entry.
        if (runtimeRefreshPromises.get(environmentId) === pending) {
          set((s) => ({
            runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [environmentId]: typed },
            isDetectingRuntimeAgents: {
              ...s.isDetectingRuntimeAgents,
              [environmentId]: false
            },
            isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [environmentId]: false }
          }))
        }
        return typed
      })
      .catch(() => {
        // Why: a disconnected runtime must keep Refresh retryable and must not
        // wipe the last known agent list.
        if (runtimeRefreshPromises.get(environmentId) === pending) {
          set((s) => ({
            isDetectingRuntimeAgents: {
              ...s.isDetectingRuntimeAgents,
              [environmentId]: false
            },
            isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [environmentId]: false }
          }))
        }
        return get().runtimeDetectedAgentIds[environmentId] ?? []
      })
      .finally(() => {
        if (runtimeRefreshPromises.get(environmentId) === pending) {
          runtimeRefreshPromises.delete(environmentId)
        }
      })

    runtimeRefreshPromises.set(environmentId, pending)
    return pending
  },

  clearRuntimeDetectedAgents: (environmentId: string) => {
    runtimeDetectPromises.delete(environmentId)
    runtimeRefreshPromises.delete(environmentId)
    set((s) => {
      const { [environmentId]: _, ...restAgents } = s.runtimeDetectedAgentIds
      const { [environmentId]: __, ...restLoading } = s.isDetectingRuntimeAgents
      const { [environmentId]: ___, ...restRefreshing } = s.isRefreshingRuntimeAgents
      return {
        runtimeDetectedAgentIds: restAgents,
        isDetectingRuntimeAgents: restLoading,
        isRefreshingRuntimeAgents: restRefreshing
      }
    })
  },

  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => {
    const keep = new Set(environmentIds)
    for (const id of runtimeDetectPromises.keys()) {
      if (!keep.has(id)) {
        runtimeDetectPromises.delete(id)
      }
    }
    for (const id of runtimeRefreshPromises.keys()) {
      if (!keep.has(id)) {
        runtimeRefreshPromises.delete(id)
      }
    }
    set((s) => {
      let changed = false
      const nextAgents = { ...s.runtimeDetectedAgentIds }
      const nextLoading = { ...s.isDetectingRuntimeAgents }
      const nextRefreshing = { ...s.isRefreshingRuntimeAgents }
      for (const id of Object.keys(nextAgents)) {
        if (!keep.has(id)) {
          delete nextAgents[id]
          changed = true
        }
      }
      for (const id of Object.keys(nextLoading)) {
        if (!keep.has(id)) {
          delete nextLoading[id]
          changed = true
        }
      }
      for (const id of Object.keys(nextRefreshing)) {
        if (!keep.has(id)) {
          delete nextRefreshing[id]
          changed = true
        }
      }
      return changed
        ? {
            runtimeDetectedAgentIds: nextAgents,
            isDetectingRuntimeAgents: nextLoading,
            isRefreshingRuntimeAgents: nextRefreshing
          }
        : s
    })
  }
})

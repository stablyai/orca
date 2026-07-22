import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  createLocalDetectedAgentsState,
  type LocalDetectedAgentsSlice
} from './local-detected-agents'

export type DetectedAgentsSlice = LocalDetectedAgentsSlice & {
  // Why: remote worktrees need per-connection agent detection. The local
  // detectedAgentIds field is connection-unaware, so remote state lives in a
  // separate map keyed by SSH connectionId.
  remoteDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRemoteAgents: Record<string, boolean>
  ensureRemoteDetectedAgents: (
    connectionId: string,
    options?: { force?: boolean }
  ) => Promise<TuiAgent[]>
  /** Forces one fresh SSH probe per connection while preserving the cached list. */
  refreshRemoteDetectedAgents: (connectionId: string) => Promise<TuiAgent[]>
  clearRemoteDetectedAgents: (connectionId: string) => void

  // Why: remote runtime hosts are not SSH connections, but their tab-bar
  // launch menu still has to probe the host where the workspace actually runs.
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRuntimeAgents: Record<string, boolean>
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
  clearRuntimeDetectedAgents: (environmentId: string) => void
  /** Drops runtime detected-agent caches for environments not in the kept set.
   *  Wired into setRuntimeEnvironments so removed environments don't leak their
   *  detected-agent entries for the renderer session. */
  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => void
}

const remoteDetectPromises = new Map<string, Promise<TuiAgent[]>>()
const remoteRefreshPromises = new Map<string, Promise<TuiAgent[]>>()
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
  ...createLocalDetectedAgentsState(set, get),

  remoteDetectedAgentIds: {},
  isDetectingRemoteAgents: {},
  runtimeDetectedAgentIds: {},
  isDetectingRuntimeAgents: {},

  ensureRemoteDetectedAgents: (connectionId: string, options?: { force?: boolean }) => {
    const existing = get().remoteDetectedAgentIds[connectionId]
    // Why: an empty result ([]) is truthy, so a prior "no agents found" detection
    // must not be treated as cached — re-detect so a later install / PATH fix is
    // picked up without a reconnect. Non-empty results still short-circuit.
    if (existing?.length && options?.force !== true) {
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
        if (remoteDetectPromises.get(connectionId) === pending) {
          set((s) => ({
            remoteDetectedAgentIds: { ...s.remoteDetectedAgentIds, [connectionId]: typed },
            isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: false }
          }))
        }
        return typed
      })
      .catch(() => {
        // Why: allow retry on next call (SSH may reconnect). Do not cache failure.
        if (remoteDetectPromises.get(connectionId) === pending) {
          set((s) => ({
            isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: false }
          }))
        }
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

  refreshRemoteDetectedAgents: (connectionId: string) => {
    const inflightRefresh = remoteRefreshPromises.get(connectionId)
    if (inflightRefresh) {
      return inflightRefresh
    }
    const inflightDetect = remoteDetectPromises.get(connectionId)
    if (inflightDetect) {
      return inflightDetect
    }

    const pending = get()
      .ensureRemoteDetectedAgents(connectionId, { force: true })
      .finally(() => {
        if (remoteRefreshPromises.get(connectionId) === pending) {
          remoteRefreshPromises.delete(connectionId)
        }
      })
    remoteRefreshPromises.set(connectionId, pending)
    return pending
  },

  // Why: the remote agent list is tied to a live SSH connection. On disconnect
  // the relay is gone, so clear both the cached result and the deduplication
  // promise. When the user reconnects and opens the quick-launch menu,
  // ensureRemoteDetectedAgents will re-detect against the new relay.
  clearRemoteDetectedAgents: (connectionId: string) => {
    remoteDetectPromises.delete(connectionId)
    remoteRefreshPromises.delete(connectionId)
    set((s) => {
      const { [connectionId]: _, ...restAgents } = s.remoteDetectedAgentIds
      const { [connectionId]: __, ...restLoading } = s.isDetectingRemoteAgents
      return { remoteDetectedAgentIds: restAgents, isDetectingRemoteAgents: restLoading }
    })
  },

  ensureRuntimeDetectedAgents: (environmentId: string) => {
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

  clearRuntimeDetectedAgents: (environmentId: string) => {
    runtimeDetectPromises.delete(environmentId)
    set((s) => {
      const { [environmentId]: _, ...restAgents } = s.runtimeDetectedAgentIds
      const { [environmentId]: __, ...restLoading } = s.isDetectingRuntimeAgents
      return { runtimeDetectedAgentIds: restAgents, isDetectingRuntimeAgents: restLoading }
    })
  },

  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => {
    const keep = new Set(environmentIds)
    for (const id of runtimeDetectPromises.keys()) {
      if (!keep.has(id)) {
        runtimeDetectPromises.delete(id)
      }
    }
    set((s) => {
      let changed = false
      const nextAgents = { ...s.runtimeDetectedAgentIds }
      const nextLoading = { ...s.isDetectingRuntimeAgents }
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
      return changed
        ? { runtimeDetectedAgentIds: nextAgents, isDetectingRuntimeAgents: nextLoading }
        : s
    })
  }
})

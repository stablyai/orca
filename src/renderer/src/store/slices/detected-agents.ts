import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/types'
import { createLocalDetectedAgentState } from './local-detected-agent-state'
import type { LocalDetectedAgentState } from './local-detected-agent-store-state'

export type DetectedAgentsSlice = LocalDetectedAgentState & {
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
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
const remoteDetectPromises = new Map<string, Promise<TuiAgent[]>>()
const remoteRefreshPromises = new Map<string, Promise<TuiAgent[]>>()

export function _getRemoteDetectPromiseCountForTest(): number {
  return remoteDetectPromises.size
}

export const createDetectedAgentsSlice: StateCreator<AppState, [], [], DetectedAgentsSlice> = (
  set,
  get,
  store
) => ({
  ...createLocalDetectedAgentState(set, get, store),
  remoteDetectedAgentIds: {},
  isDetectingRemoteAgents: {},

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
  }
})

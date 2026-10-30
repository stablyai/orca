import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { createLocalDetectedAgentState } from './local-detected-agent-state'
import type { LocalDetectedAgentState } from './local-detected-agent-store-state'

export type DetectedAgentsSlice = LocalDetectedAgentState & {
  // Local detection lacks connection identity; cache remote results per SSH connection.
  remoteAgentInventoryOutcome: (key: string) => 'pending' | 'successful' | 'failed'
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

// Keep dedupe promises outside Zustand state.
const remoteDetectPromises = new Map<string, Promise<TuiAgent[]>>()
const latestOutcome = new Map<string, 'pending' | 'successful' | 'failed'>()
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
  remoteAgentInventoryOutcome: (key) => latestOutcome.get(key) ?? 'pending',
  remoteDetectedAgentIds: {},
  isDetectingRemoteAgents: {},

  ensureRemoteDetectedAgents: (connectionId: string, options?: { force?: boolean }) => {
    const existing = get().remoteDetectedAgentIds[connectionId]
    // Cache only nonempty detections; retry [] so install/PATH fixes need no reconnect.
    if (existing?.length && options?.force !== true) {
      return Promise.resolve(existing)
    }
    const inflight = remoteDetectPromises.get(connectionId)
    if (inflight) {
      return inflight
    }

    latestOutcome.set(connectionId, 'pending')
    set((s) => ({
      isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: true }
    }))

    const pending = window.api.preflight
      .detectRemoteAgents({ connectionId })
      .then((ids) => {
        const typed = ids as TuiAgent[]
        if (remoteDetectPromises.get(connectionId) === pending) {
          latestOutcome.set(connectionId, 'successful')
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
          latestOutcome.set(connectionId, 'failed')
          set((s) => ({
            isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: false }
          }))
        }
        return [] as TuiAgent[]
      })
      .finally(() => {
        // Retain only pending promises; resolved results already live in remoteDetectedAgentIds and would leak duplicate entries.
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

  // Disconnect retires relay: clear results and pending dedupe so quick-launch redetects after reconnect.
  clearRemoteDetectedAgents: (connectionId: string) => {
    latestOutcome.delete(connectionId)
    remoteDetectPromises.delete(connectionId)
    remoteRefreshPromises.delete(connectionId)
    set((s) => {
      const { [connectionId]: _, ...restAgents } = s.remoteDetectedAgentIds
      const { [connectionId]: __, ...restLoading } = s.isDetectingRemoteAgents
      return { remoteDetectedAgentIds: restAgents, isDetectingRemoteAgents: restLoading }
    })
  }
})

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

export type MemorySlice = {
  /** Keyed by execution host id; the local host is always present once seeded. */
  memorySnapshotByHostId: Record<string, MemorySnapshot | null>
  memorySnapshotErrorByHostId: Record<string, string | null>
  fetchMemorySnapshot: (executionHostId?: string) => Promise<void>
}

export const createMemorySlice: StateCreator<AppState, [], [], MemorySlice> = (set) => {
  // Why: one entry per host — a slow remote poll must not swallow the local one.
  const inFlightByHostId = new Map<string, Promise<void>>()

  return {
    memorySnapshotByHostId: {},
    memorySnapshotErrorByHostId: {},

    fetchMemorySnapshot: (executionHostId = LOCAL_EXECUTION_HOST_ID) => {
      const hostId = executionHostId || LOCAL_EXECUTION_HOST_ID
      const existing = inFlightByHostId.get(hostId)
      if (existing) {
        return existing
      }
      const request = (async () => {
        try {
          const snapshot = await window.api.memory.getSnapshot({ executionHostId: hostId })
          set((state) => ({
            memorySnapshotByHostId: { ...state.memorySnapshotByHostId, [hostId]: snapshot },
            memorySnapshotErrorByHostId: { ...state.memorySnapshotErrorByHostId, [hostId]: null }
          }))
        } catch (err) {
          // Why: the always-on Resource Manager status-bar segment needs to know when
          // the snapshot IPC is failing so it can surface a "daemon not responding"
          // banner with a Restart CTA. For a remote host the same signal reads as
          // "unreachable" — never as an idle machine.
          console.error(`Failed to fetch memory snapshot for ${hostId}:`, err)
          set((state) => ({
            memorySnapshotErrorByHostId: {
              ...state.memorySnapshotErrorByHostId,
              [hostId]: err instanceof Error ? err.message : String(err)
            }
          }))
        }
      })()
      const trackedRequest = request.finally(() => {
        if (inFlightByHostId.get(hostId) === trackedRequest) {
          inFlightByHostId.delete(hostId)
        }
      })
      inFlightByHostId.set(hostId, trackedRequest)
      return trackedRequest
    }
  }
}

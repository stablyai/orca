import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { MemorySnapshot } from '../../../../shared/types'

export type MemorySlice = {
  memorySnapshot: MemorySnapshot | null
  memorySnapshotError: string | null
  fetchMemorySnapshot: () => Promise<void>
}

export const createMemorySlice: StateCreator<AppState, [], [], MemorySlice> = (set) => ({
  memorySnapshot: null,
  memorySnapshotError: null,

  fetchMemorySnapshot: async () => {
    try {
      const snapshot = await window.api.memory.getSnapshot()
      set({ memorySnapshot: snapshot, memorySnapshotError: null })
    } catch (err) {
      // Why: the always-on Resource Usage status-bar segment needs to know when
      // the snapshot IPC is failing so it can surface a "daemon not responding"
      // banner with a Restart CTA. Prior code only console.error'd.
      console.error('Failed to fetch memory snapshot:', err)
      set({
        memorySnapshotError: err instanceof Error ? err.message : String(err)
      })
    }
  }
})

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { MemorySnapshot } from '../../../../shared/types'

export type MemorySlice = {
  memorySnapshot: MemorySnapshot | null
  fetchMemorySnapshot: () => Promise<void>
}

export const createMemorySlice: StateCreator<AppState, [], [], MemorySlice> = (set) => ({
  memorySnapshot: null,

  fetchMemorySnapshot: async () => {
    try {
      const snapshot = await window.api.memory.getSnapshot()
      set({ memorySnapshot: snapshot })
    } catch (err) {
      console.error('Failed to fetch memory snapshot:', err)
    }
  }
})

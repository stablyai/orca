import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'

export type MemorySlice = {
  memorySnapshot: MemorySnapshot | null
  memorySnapshotError: string | null
}

export const createMemorySlice: StateCreator<AppState, [], [], MemorySlice> = () => ({
  memorySnapshot: null,
  memorySnapshotError: null
})

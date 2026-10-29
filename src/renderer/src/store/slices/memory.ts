import type { SessionStateCreator } from '@/store/session-source-write-boundary'
import type { AppState } from '../types'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'

export type MemorySlice = {
  memorySnapshot: MemorySnapshot | null
  memorySnapshotError: string | null
}

export const createMemorySlice: SessionStateCreator<AppState, MemorySlice> = () => ({
  memorySnapshot: null,
  memorySnapshotError: null
})

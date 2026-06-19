import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySlice } from './memory'
import type { AppState } from '../types'
import type { MemorySnapshot } from '../../../../shared/types'

function makeMemorySnapshot(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    app: {
      cpu: 1,
      memory: 1024,
      main: { cpu: 1, memory: 512 },
      renderer: { cpu: 0, memory: 256 },
      other: { cpu: 0, memory: 256 },
      history: [1024]
    },
    worktrees: [],
    host: {
      totalMemory: 8192,
      freeMemory: 4096,
      usedMemory: 4096,
      memoryUsagePercent: 50,
      cpuCoreCount: 8,
      loadAverage1m: 1
    },
    totalCpu: 1,
    totalMemory: 1024,
    collectedAt: 1,
    ...overrides
  }
}

function makeStore() {
  return create<Pick<AppState, 'memorySnapshot' | 'memorySnapshotError' | 'fetchMemorySnapshot'>>()(
    (...args) => createMemorySlice(...(args as Parameters<typeof createMemorySlice>))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createMemorySlice', () => {
  it('dedupes concurrent memory snapshot IPC calls', async () => {
    let resolveSnapshot: (snapshot: MemorySnapshot) => void = () => {}
    const getSnapshot = vi.fn(
      () =>
        new Promise<MemorySnapshot>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    vi.stubGlobal('window', { api: { memory: { getSnapshot } } })

    const store = makeStore()
    const first = store.getState().fetchMemorySnapshot()
    const second = store.getState().fetchMemorySnapshot()

    expect(getSnapshot).toHaveBeenCalledTimes(1)
    resolveSnapshot(makeMemorySnapshot({ collectedAt: 10 }))
    await Promise.all([first, second])

    expect(store.getState().memorySnapshot?.collectedAt).toBe(10)
    getSnapshot.mockResolvedValueOnce(makeMemorySnapshot({ collectedAt: 11 }))
    await store.getState().fetchMemorySnapshot()

    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(store.getState().memorySnapshot?.collectedAt).toBe(11)
  })
})

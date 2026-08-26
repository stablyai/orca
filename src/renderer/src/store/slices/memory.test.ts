import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySlice } from './memory'
import type { AppState } from '../types'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'

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
      availableMemory: 4096,
      availableMemorySource: 'free-memory',
      usedMemory: 4096,
      memoryUsagePercent: 50,
      cpuCoreCount: 8,
      loadAverage1m: 1
    },
    processMemoryMetric: 'rss',
    totalCpu: 1,
    totalMemory: 1024,
    collectedAt: 1,
    ...overrides
  }
}

function makeStore() {
  return create<
    Pick<AppState, 'memorySnapshotByHostId' | 'memorySnapshotErrorByHostId' | 'fetchMemorySnapshot'>
  >()((...args) => createMemorySlice(...(args as Parameters<typeof createMemorySlice>)))
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

    expect(store.getState().memorySnapshotByHostId.local?.collectedAt).toBe(10)
    getSnapshot.mockResolvedValueOnce(makeMemorySnapshot({ collectedAt: 11 }))
    await store.getState().fetchMemorySnapshot()

    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(store.getState().memorySnapshotByHostId.local?.collectedAt).toBe(11)
  })

  it('keeps a slow remote poll from blocking the local one', async () => {
    const getSnapshot = vi.fn((request?: { executionHostId?: string | null }) =>
      request?.executionHostId === 'runtime:env-1'
        ? new Promise<MemorySnapshot>(() => {})
        : Promise.resolve(makeMemorySnapshot({ collectedAt: 20 }))
    )
    vi.stubGlobal('window', { api: { memory: { getSnapshot } } })

    const store = makeStore()
    void store.getState().fetchMemorySnapshot('runtime:env-1')
    await store.getState().fetchMemorySnapshot()

    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(store.getState().memorySnapshotByHostId.local?.collectedAt).toBe(20)
    expect(store.getState().memorySnapshotByHostId['runtime:env-1']).toBeUndefined()
  })

  it('records a per-host error without clobbering another host', async () => {
    const getSnapshot = vi.fn((request?: { executionHostId?: string | null }) =>
      request?.executionHostId === 'runtime:env-1'
        ? Promise.reject(new Error('runtime_unavailable'))
        : Promise.resolve(makeMemorySnapshot({ collectedAt: 30 }))
    )
    vi.stubGlobal('window', { api: { memory: { getSnapshot } } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const store = makeStore()
    await store.getState().fetchMemorySnapshot()
    await store.getState().fetchMemorySnapshot('runtime:env-1')

    expect(store.getState().memorySnapshotErrorByHostId['runtime:env-1']).toBe(
      'runtime_unavailable'
    )
    expect(store.getState().memorySnapshotErrorByHostId.local).toBeNull()
    expect(store.getState().memorySnapshotByHostId.local?.collectedAt).toBe(30)
  })
})

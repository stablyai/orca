// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'
import { useAppStore } from '../../store'
import { createEmptyMemorySnapshot } from '../../web/preload-api/web-memory-api'
import { useResourceMemorySnapshot } from './use-resource-memory-snapshot'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))

const snapshot = (collectedAt: number): MemorySnapshot => ({
  ...createEmptyMemorySnapshot(),
  collectedAt
})
const getSnapshot = vi.fn<() => Promise<MemorySnapshot>>()
const flush = () => act(async () => {})
const setup = (active = true) =>
  renderHook(({ active }) => useResourceMemorySnapshot(active), { initialProps: { active } })

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(useAppStore.setState).mockClear()
  getSnapshot.mockReset().mockResolvedValue(snapshot(1))
  vi.stubGlobal('api', { memory: { getSnapshot } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Resource Manager memory observation', () => {
  it('coalesces concurrent refreshes and only polls while active', async () => {
    const pending = Promise.withResolvers<MemorySnapshot>()
    getSnapshot.mockReturnValueOnce(pending.promise)
    const { result, rerender } = setup(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(getSnapshot).not.toHaveBeenCalled()
    rerender({ active: true })
    act(() => {
      void result.current()
      void result.current()
    })
    expect(getSnapshot).toHaveBeenCalledExactlyOnceWith({ resourceManagerView: true })
    await act(async () => {
      pending.resolve(snapshot(10))
    })
    expect(useAppStore.setState).toHaveBeenCalledExactlyOnceWith({
      memorySnapshot: snapshot(10),
      memorySnapshotError: null
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    rerender({ active: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards hidden results and reconciles one new epoch without overlapping requests', async () => {
    const old = Promise.withResolvers<MemorySnapshot>()
    const current = Promise.withResolvers<MemorySnapshot>()
    getSnapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const { result, rerender } = setup()
    rerender({ active: false })
    rerender({ active: true })
    act(() => {
      void result.current()
      void result.current()
    })
    expect(getSnapshot).toHaveBeenCalledOnce()
    await act(async () => {
      old.resolve(snapshot(10))
    })
    expect(useAppStore.setState).not.toHaveBeenCalled()
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    await act(async () => {
      current.resolve(snapshot(20))
    })
    expect(useAppStore.setState).toHaveBeenCalledExactlyOnceWith({
      memorySnapshot: snapshot(20),
      memorySnapshotError: null
    })
  })

  it('does not let an old native visibility veto cancel a newly visible epoch', async () => {
    const old = Promise.withResolvers<MemorySnapshot>()
    getSnapshot.mockReturnValueOnce(old.promise)
    const { rerender } = setup()
    rerender({ active: false })
    rerender({ active: true })
    await act(async () => {
      old.reject(new Error('view_not_visible'))
    })
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(useAppStore.setState).toHaveBeenCalledExactlyOnceWith({
      memorySnapshot: snapshot(1),
      memorySnapshotError: null
    })
  })

  it('retains the last observation after a read failure and allows an explicit retry', async () => {
    const { result } = setup()
    await flush()
    getSnapshot.mockRejectedValueOnce(new Error('unavailable'))
    await act(async () => {
      await result.current()
    })
    expect(useAppStore.setState).toHaveBeenLastCalledWith({
      memorySnapshotError: 'Error: unavailable'
    })
    await act(async () => {
      await result.current()
    })
    expect(useAppStore.setState).toHaveBeenLastCalledWith({
      memorySnapshot: snapshot(1),
      memorySnapshotError: null
    })
  })

  it('permits refresh after a native veto without requiring a different visibility prop', async () => {
    getSnapshot.mockRejectedValueOnce(new Error('view_not_visible'))
    const { result } = setup()
    await flush()
    expect(useAppStore.setState).not.toHaveBeenCalled()
    await act(async () => {
      await result.current()
    })
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(useAppStore.setState).toHaveBeenCalledExactlyOnceWith({
      memorySnapshot: snapshot(1),
      memorySnapshotError: null
    })
  })
})

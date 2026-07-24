// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonSession } from './resource-usage-merge-types'
import { useResourceSessionInventory } from './use-resource-session-inventory'

function session(id: string): DaemonSession {
  return { id, cwd: '/workspace', title: id }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useResourceSessionInventory', () => {
  const listSessions = vi.fn<() => Promise<DaemonSession[]>>()
  const unsubscribeSpawned = vi.fn()
  const unsubscribeExit = vi.fn()
  let spawnedCallback: ((data: { id: string }) => void) | null = null
  let exitCallback: ((data: { id: string; code: number }) => void) | null = null

  beforeEach(() => {
    spawnedCallback = null
    exitCallback = null
    listSessions.mockReset()
    unsubscribeSpawned.mockReset()
    unsubscribeExit.mockReset()
    ;(window as unknown as { api: unknown }).api = {
      pty: {
        listSessions,
        onSpawned: (callback: (data: { id: string }) => void) => {
          spawnedCallback = callback
          return unsubscribeSpawned
        },
        onExit: (callback: (data: { id: string; code: number }) => void) => {
          exitCallback = callback
          return unsubscribeExit
        }
      }
    }
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('seeds from the daemon inventory and resets when session restore is not ready', async () => {
    listSessions.mockResolvedValue([session('one'), session('two')])
    const { result, rerender } = renderHook(({ ready }) => useResourceSessionInventory(ready), {
      initialProps: { ready: false }
    })

    expect(result.current.sessionInventory.count).toBe(0)
    expect(listSessions).not.toHaveBeenCalled()

    rerender({ ready: true })
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(2))
    expect(listSessions).toHaveBeenCalledTimes(1)

    rerender({ ready: false })
    expect(result.current.sessionInventory.count).toBe(0)
    expect(result.current.sessionsError).toBe(false)
  })

  it('recovers inventory and clears the error after a failed readiness seed', async () => {
    listSessions
      .mockRejectedValueOnce(new Error('daemon unavailable'))
      .mockResolvedValueOnce([session('recovered')])
    const { result } = renderHook(() => useResourceSessionInventory(true))

    await waitFor(() => expect(result.current.sessionsError).toBe(true))
    await act(async () => {
      await result.current.refreshSessions()
    })

    expect(result.current.sessionInventory.sessions).toEqual([session('recovered')])
    expect(result.current.sessionsError).toBe(false)
  })

  it('refreshes for background spawns without depending on mounted pane state', async () => {
    listSessions
      .mockResolvedValueOnce([session('one')])
      .mockResolvedValue([session('one'), session('background')])
    const { result } = renderHook(() => useResourceSessionInventory(true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    await act(async () => {
      spawnedCallback?.({ id: 'one' })
      spawnedCallback?.({ id: 'background' })
      spawnedCallback?.({ id: 'background-2' })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    await waitFor(() => expect(result.current.sessionInventory.count).toBe(2))
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('does not inventory again when an existing session reattaches', async () => {
    listSessions.mockResolvedValue([session('one')])
    const { result } = renderHook(() => useResourceSessionInventory(true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      spawnedCallback?.({ id: 'one' })
    })

    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('does not overlap provider-wide inventory reads for spawns during a slow refresh', async () => {
    listSessions.mockResolvedValueOnce([session('one')])
    const { result } = renderHook(() => useResourceSessionInventory(true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    const inFlight = deferred<DaemonSession[]>()
    listSessions.mockReturnValueOnce(inFlight.promise)
    await act(async () => {
      spawnedCallback?.({ id: 'background-one' })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(listSessions).toHaveBeenCalledTimes(2)

    await act(async () => {
      spawnedCallback?.({ id: 'background-two' })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(listSessions).toHaveBeenCalledTimes(2)

    await act(async () => {
      inFlight.resolve([session('one'), session('background-one'), session('background-two')])
      await inFlight.promise
    })
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(3))
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('reconciles once when an in-flight inventory misses a later spawn', async () => {
    listSessions.mockResolvedValueOnce([session('one')])
    const { result } = renderHook(() => useResourceSessionInventory(true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    const inFlight = deferred<DaemonSession[]>()
    listSessions
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValueOnce([session('one'), session('background-one'), session('background-two')])
    await act(async () => {
      spawnedCallback?.({ id: 'background-one' })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    act(() => {
      spawnedCallback?.({ id: 'background-two' })
    })

    await act(async () => {
      inFlight.resolve([session('one'), session('background-one')])
      await inFlight.promise
    })
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(3))
    expect(listSessions).toHaveBeenCalledTimes(3)
  })

  it('cancels a queued inventory read when the unknown session exits first', async () => {
    listSessions.mockResolvedValueOnce([session('one')])
    const { result } = renderHook(() => useResourceSessionInventory(true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      spawnedCallback?.({ id: 'short-lived' })
      exitCallback?.({ id: 'short-lived', code: 0 })
    })
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(result.current.sessionInventory.count).toBe(1)
  })

  it('does not schedule follow-up inventory after unmount', async () => {
    listSessions.mockResolvedValueOnce([session('one')])
    const { result, unmount } = renderHook(() => useResourceSessionInventory(true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    const inFlight = deferred<DaemonSession[]>()
    listSessions.mockReturnValueOnce(inFlight.promise)
    await act(async () => {
      spawnedCallback?.({ id: 'background-one' })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    act(() => {
      spawnedCallback?.({ id: 'background-two' })
    })
    unmount()

    inFlight.resolve([session('one'), session('background-one')])
    await inFlight.promise
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('filters an exit from an in-flight list without losing other new sessions', async () => {
    listSessions.mockResolvedValueOnce([session('one'), session('exited')])
    const { result } = renderHook(() => useResourceSessionInventory(true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(2))

    const stale = deferred<DaemonSession[]>()
    listSessions.mockReturnValueOnce(stale.promise)
    let refresh!: Promise<void>
    act(() => {
      refresh = result.current.refreshSessions()
    })
    act(() => {
      exitCallback?.({ id: 'exited', code: 0 })
    })
    expect(result.current.sessionInventory.sessions.map(({ id }) => id)).toEqual(['one'])

    await act(async () => {
      stale.resolve([session('one'), session('exited'), session('background')])
      await refresh
    })
    expect(result.current.sessionInventory.sessions.map(({ id }) => id)).toEqual([
      'one',
      'background'
    ])
  })

  it('keeps the newest result when refreshes resolve out of order', async () => {
    listSessions.mockResolvedValueOnce([session('one')])
    const { result } = renderHook(() => useResourceSessionInventory(true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    const older = deferred<DaemonSession[]>()
    const newer = deferred<DaemonSession[]>()
    listSessions.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    let olderRefresh!: Promise<void>
    let newerRefresh!: Promise<void>
    act(() => {
      olderRefresh = result.current.refreshSessions()
      newerRefresh = result.current.refreshSessions()
    })

    await act(async () => {
      newer.resolve([session('one'), session('two')])
      await newerRefresh
    })
    await act(async () => {
      older.resolve([session('one')])
      await olderRefresh
    })

    expect(result.current.sessionInventory.count).toBe(2)
  })

  it('unsubscribes from lifecycle events on unmount', () => {
    listSessions.mockResolvedValue([])
    const { unmount } = renderHook(() => useResourceSessionInventory(true))

    unmount()

    expect(unsubscribeSpawned).toHaveBeenCalledTimes(1)
    expect(unsubscribeExit).toHaveBeenCalledTimes(1)
  })
})

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
  const listSessionIds = vi.fn<() => Promise<string[]>>()
  const listSessions = vi.fn<() => Promise<DaemonSession[]>>()
  const unsubscribeSpawned = vi.fn()
  const unsubscribeExit = vi.fn()
  let spawnedCallback: ((data: { id: string }) => void) | null = null
  let exitCallback: ((data: { id: string; code: number }) => void) | null = null

  beforeEach(() => {
    spawnedCallback = null
    exitCallback = null
    listSessionIds.mockReset()
    listSessions.mockReset()
    unsubscribeSpawned.mockReset()
    unsubscribeExit.mockReset()
    ;(window as unknown as { api: unknown }).api = {
      pty: {
        listSessionIds,
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

  it('seeds the closed badge from IDs without listing details and resets with readiness', async () => {
    listSessionIds.mockResolvedValue(['one', 'two'])
    const { result, rerender } = renderHook(
      ({ ready }) => useResourceSessionInventory(ready, false),
      { initialProps: { ready: false } }
    )

    expect(listSessionIds).not.toHaveBeenCalled()
    rerender({ ready: true })
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(2))

    expect(result.current.sessionInventory.sessions).toEqual([])
    expect(listSessionIds).toHaveBeenCalledTimes(1)
    expect(listSessions).not.toHaveBeenCalled()

    rerender({ ready: false })
    expect(result.current.sessionInventory.count).toBe(0)
    expect(result.current.sessionsError).toBe(false)
  })

  it('recovers a failed ID seed through an explicit detail refresh', async () => {
    listSessionIds.mockRejectedValue(new Error('daemon unavailable'))
    listSessions.mockResolvedValue([session('recovered')])
    const { result } = renderHook(() => useResourceSessionInventory(true, true))

    await waitFor(() => expect(result.current.sessionsError).toBe(true))
    await act(async () => {
      await result.current.refreshSessions()
    })

    expect(result.current.sessionInventory.sessions).toEqual([session('recovered')])
    expect(result.current.sessionsError).toBe(false)
  })

  it('uses only ID inventory for closed lifecycle signals and ignores known reattaches', async () => {
    listSessionIds
      .mockResolvedValueOnce(['one'])
      .mockResolvedValueOnce(['one', 'background', 'background-2'])
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      spawnedCallback?.({ id: 'one' })
    })
    expect(listSessionIds).toHaveBeenCalledTimes(1)

    await act(async () => {
      spawnedCallback?.({ id: 'background' })
      spawnedCallback?.({ id: 'background-2' })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(3))

    expect(listSessionIds).toHaveBeenCalledTimes(2)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('coalesces an ID seed and runs one cheap follow-up when it misses a later spawn', async () => {
    const seed = deferred<string[]>()
    listSessionIds
      .mockReturnValueOnce(seed.promise)
      .mockResolvedValueOnce(['one', 'background-one', 'background-two'])
    const { result } = renderHook(() => useResourceSessionInventory(true, false))

    await act(async () => {
      spawnedCallback?.({ id: 'background-one' })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(listSessionIds).toHaveBeenCalledTimes(1)

    act(() => {
      spawnedCallback?.({ id: 'background-two' })
    })
    await act(async () => {
      seed.resolve(['one', 'background-one'])
      await seed.promise
    })

    await waitFor(() => expect(result.current.sessionInventory.count).toBe(3))
    expect(listSessionIds).toHaveBeenCalledTimes(2)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('does not resurrect an exit that races the ID seed', async () => {
    const seed = deferred<string[]>()
    listSessionIds.mockReturnValue(seed.promise)
    const { result } = renderHook(() => useResourceSessionInventory(true, false))

    act(() => {
      exitCallback?.({ id: 'exited', code: 0 })
    })
    await act(async () => {
      seed.resolve(['live', 'exited'])
      await seed.promise
    })

    expect(result.current.sessionInventory.sessionIds).toEqual(['live'])
    expect(result.current.sessionInventory.count).toBe(1)
  })

  it('uses full details for lifecycle refreshes while open', async () => {
    listSessionIds.mockResolvedValue(['one'])
    listSessions.mockResolvedValue([session('one'), session('background')])
    const { result } = renderHook(() => useResourceSessionInventory(true, true))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    await act(async () => {
      spawnedCallback?.({ id: 'background' })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    await waitFor(() => expect(result.current.sessionInventory.sessions).toHaveLength(2))

    expect(listSessionIds).toHaveBeenCalledTimes(1)
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('re-seeds IDs when closing cancels a queued detail refresh', async () => {
    listSessionIds
      .mockResolvedValueOnce(['one'])
      .mockResolvedValueOnce(['one', 'queued-before-close'])
    const { result, rerender } = renderHook(
      ({ detailsEnabled }) => useResourceSessionInventory(true, detailsEnabled),
      { initialProps: { detailsEnabled: true } }
    )
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      spawnedCallback?.({ id: 'queued-before-close' })
      rerender({ detailsEnabled: false })
    })
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(2))

    expect(listSessionIds).toHaveBeenCalledTimes(2)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('starts a fresh close seed when a detail refresh superseded the first ID seed', async () => {
    const staleSeed = deferred<string[]>()
    const detailRefresh = deferred<DaemonSession[]>()
    listSessionIds
      .mockReturnValueOnce(staleSeed.promise)
      .mockResolvedValueOnce(['one', 'queued-before-close'])
    listSessions.mockReturnValue(detailRefresh.promise)
    const { result, rerender } = renderHook(
      ({ detailsEnabled }) => useResourceSessionInventory(true, detailsEnabled),
      { initialProps: { detailsEnabled: true } }
    )
    await waitFor(() => expect(listSessionIds).toHaveBeenCalledTimes(1))

    let details!: Promise<void>
    act(() => {
      details = result.current.refreshSessions()
      spawnedCallback?.({ id: 'queued-before-close' })
      rerender({ detailsEnabled: false })
    })
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(2))

    await act(async () => {
      detailRefresh.resolve([session('one')])
      staleSeed.resolve(['one'])
      await Promise.all([details, staleSeed.promise])
    })
    expect(result.current.sessionInventory.sessionIds).toEqual(['one', 'queued-before-close'])
    expect(listSessionIds).toHaveBeenCalledTimes(2)
  })

  it('keeps the newer detail result when an older ID seed resolves later', async () => {
    const seed = deferred<string[]>()
    listSessionIds.mockReturnValue(seed.promise)
    listSessions.mockResolvedValue([session('one'), session('newer')])
    const { result } = renderHook(() => useResourceSessionInventory(true, true))

    await act(async () => {
      await result.current.refreshSessions()
    })
    await act(async () => {
      seed.resolve(['one'])
      await seed.promise
    })

    expect(result.current.sessionInventory.sessions).toEqual([session('one'), session('newer')])
    expect(result.current.sessionInventory.count).toBe(2)
  })

  it('unsubscribes from lifecycle events on unmount', () => {
    listSessionIds.mockResolvedValue([])
    const { unmount } = renderHook(() => useResourceSessionInventory(true, false))

    unmount()

    expect(unsubscribeSpawned).toHaveBeenCalledTimes(1)
    expect(unsubscribeExit).toHaveBeenCalledTimes(1)
  })
})

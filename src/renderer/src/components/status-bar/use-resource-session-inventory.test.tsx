// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  EMPTY_DAEMON_SESSION_ROWS,
  ResourceSessionInventoryRows
} from './resource-session-inventory'
import type { DaemonSession } from './resource-usage-merge-types'
import { notifyDaemonSessionInventoryInvalidated } from './daemon-session-inventory-invalidation'
import { useResourceSessionInventory } from './use-resource-session-inventory'

function session(id: string): DaemonSession {
  return { id, cwd: '/workspace', title: id, agentOwnership: 'absent' as const }
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
  let spawnedCallback:
    | ((data: {
        id: string
        hostId?: ExecutionHostId
        isReattach?: boolean
        exitedBeforeSpawnReply?: true
      }) => void)
    | null = null
  let exitCallback: ((data: { id: string; code: number }) => void) | null = null
  let inventoryComplete = true
  let queriedHostIds: ExecutionHostId[] = ['local']
  let respondingHostIds: ExecutionHostId[] = ['local']
  let unavailableHostIds: ExecutionHostId[] = []
  const inventoryHostIdBySessionId = new Map<string, ExecutionHostId>()

  beforeEach(() => {
    spawnedCallback = null
    exitCallback = null
    inventoryComplete = true
    queriedHostIds = ['local']
    respondingHostIds = ['local']
    unavailableHostIds = []
    inventoryHostIdBySessionId.clear()
    listSessions.mockReset()
    unsubscribeSpawned.mockReset()
    unsubscribeExit.mockReset()
    ;(window as unknown as { api: unknown }).api = {
      pty: {
        listSessions,
        listSessionInventory: async () => {
          const sessions = await listSessions()
          return {
            sessions,
            hostIdBySessionId: Object.fromEntries(
              sessions.map(({ id }) => [id, inventoryHostIdBySessionId.get(id) ?? 'local'])
            ),
            retainedSessionIdsByHost: {},
            queriedHostIds,
            respondingHostIds,
            unavailableHostIds,
            complete: inventoryComplete
          }
        },
        onSpawned: (
          callback: (data: {
            id: string
            hostId?: ExecutionHostId
            isReattach?: boolean
            exitedBeforeSpawnReply?: true
          }) => void
        ) => {
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
    // Unmount leftover hooks so their module-level invalidation subscriptions cannot bleed into the next test.
    cleanup()
    delete (window as unknown as { api?: unknown }).api
  })

  it('seeds from the daemon inventory and resets when session restore is not ready', async () => {
    listSessions.mockResolvedValue([session('one'), session('two')])
    const { result, rerender } = renderHook(
      ({ ready }) => useResourceSessionInventory(ready, false),
      {
        initialProps: { ready: false }
      }
    )

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
    const { result } = renderHook(() => useResourceSessionInventory(true, true))

    await waitFor(() => expect(result.current.sessionsError).toBe(true))
    await act(async () => {
      await result.current.refreshSessions()
    })

    expect(result.current.sessionInventory.sessions).toEqual([session('recovered')])
    expect(result.current.sessionsError).toBe(false)
  })

  it('counts 100 authoritative novel spawns while closed without provider-wide lists', async () => {
    listSessions.mockResolvedValue([session('seed')])
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      for (let index = 0; index < 100; index += 1) {
        spawnedCallback?.({ id: `background-${index}`, isReattach: false })
      }
    })

    expect(result.current.sessionInventory.count).toBe(101)
    expect(result.current.sessionInventory.sessions).toBe(EMPTY_DAEMON_SESSION_ROWS)
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('removes 1000 closed sessions without fleet row materialization or inventory scans', async () => {
    const sessions = Array.from({ length: 1000 }, (_, index) => session(`scale-${index}`))
    const rowSnapshots = vi.spyOn(ResourceSessionInventoryRows.prototype, 'toArray')
    listSessions.mockResolvedValue(sessions)
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1000))
    const snapshotsAfterSeed = rowSnapshots.mock.calls.length
    const closedRows = result.current.sessionInventory.sessions

    act(() => {
      for (const { id } of sessions) {
        exitCallback?.({ id, code: 0 })
      }
    })

    expect(result.current.sessionInventory.count).toBe(0)
    expect(result.current.sessionInventory.sessions).toBe(closedRows)
    expect(result.current.sessionInventory.sessions).toBe(EMPTY_DAEMON_SESSION_ROWS)
    expect(rowSnapshots).toHaveBeenCalledTimes(snapshotsAfterSeed)
    expect(listSessions).toHaveBeenCalledTimes(1)
    rowSnapshots.mockRestore()
  })

  it('ignores a same-ID reattach without changing the count or listing again', async () => {
    listSessions.mockResolvedValue([session('one')])
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      spawnedCallback?.({ id: 'one', isReattach: true })
    })

    expect(result.current.sessionInventory.count).toBe(1)
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('decrements exits immediately and admits reuse of the same ID as a novel spawn', async () => {
    listSessions.mockResolvedValue([session('reused')])
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      exitCallback?.({ id: 'reused', code: 0 })
    })
    expect(result.current.sessionInventory.count).toBe(0)

    act(() => {
      spawnedCallback?.({ id: 'reused', isReattach: false })
    })
    expect(result.current.sessionInventory.count).toBe(1)
    expect(result.current.sessionInventory.sessions).toEqual([])
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('performs one authoritative reconciliation when the popover opens', async () => {
    listSessions
      .mockResolvedValueOnce([session('one')])
      .mockResolvedValueOnce([session('one'), session('background')])
    const { result, rerender } = renderHook(({ open }) => useResourceSessionInventory(true, open), {
      initialProps: { open: false }
    })
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      spawnedCallback?.({ id: 'background', isReattach: false })
    })
    expect(result.current.sessionInventory.count).toBe(2)
    expect(listSessions).toHaveBeenCalledTimes(1)

    rerender({ open: true })
    await waitFor(() =>
      expect(result.current.sessionInventory.sessions.map(({ id }) => id)).toEqual([
        'one',
        'background'
      ])
    )
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('reconciles an unknown reattach or mixed-version spawn instead of guessing', async () => {
    listSessions
      .mockResolvedValueOnce([session('one')])
      .mockResolvedValueOnce([session('one'), session('legacy')])
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))

    act(() => {
      spawnedCallback?.({ id: 'legacy' })
      spawnedCallback?.({
        id: 'already-exited',
        isReattach: false,
        exitedBeforeSpawnReply: true
      })
    })

    await waitFor(() => expect(result.current.sessionInventory.count).toBe(2))
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('prunes responding local, WSL, and SSH scopes while retaining an unavailable SSH host', async () => {
    listSessions.mockResolvedValue([])
    const { result, rerender } = renderHook(({ open }) => useResourceSessionInventory(true, open), {
      initialProps: { open: false }
    })
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1))

    act(() => {
      spawnedCallback?.({ id: 'local-stale', hostId: 'local', isReattach: false })
      spawnedCallback?.({ id: 'wsl-stale', hostId: 'local', isReattach: false })
      spawnedCallback?.({
        id: 'ssh:ssh-available@@stale',
        hostId: 'ssh:ssh-available',
        isReattach: false
      })
      spawnedCallback?.({
        id: 'ssh:ssh-unavailable@@retained',
        hostId: 'ssh:ssh-unavailable',
        isReattach: false
      })
    })
    expect(result.current.sessionInventory.count).toBe(4)
    expect(listSessions).toHaveBeenCalledTimes(1)

    inventoryComplete = false
    queriedHostIds = ['local', 'ssh:ssh-available']
    respondingHostIds = ['local', 'ssh:ssh-available']
    unavailableHostIds = ['ssh:ssh-unavailable']
    rerender({ open: true })

    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))
    expect(result.current.sessionInventory.sessions).toEqual([])
    expect(result.current.sessionsError).toBe(true)
    expect(listSessions).toHaveBeenCalledTimes(2)

    inventoryComplete = true
    queriedHostIds = ['local', 'ssh:ssh-available', 'ssh:ssh-unavailable']
    respondingHostIds = ['local', 'ssh:ssh-available', 'ssh:ssh-unavailable']
    unavailableHostIds = []
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.sessionInventory.count).toBe(0)
    expect(result.current.sessionsError).toBe(false)
    expect(listSessions).toHaveBeenCalledTimes(3)
  })

  it('seeds a cold renderer from bounded unavailable-host ownership until reconnect', async () => {
    const retainedId = 'ssh:ssh-disconnected@@retained'
    const listSessionInventory = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [],
        hostIdBySessionId: {},
        retainedSessionIdsByHost: { 'ssh:ssh-disconnected': [retainedId] },
        queriedHostIds: ['local'],
        respondingHostIds: ['local'],
        unavailableHostIds: ['ssh:ssh-disconnected'],
        complete: false
      })
      .mockResolvedValueOnce({
        sessions: [],
        hostIdBySessionId: {},
        retainedSessionIdsByHost: {},
        queriedHostIds: ['local', 'ssh:ssh-disconnected'],
        respondingHostIds: ['local', 'ssh:ssh-disconnected'],
        unavailableHostIds: [],
        complete: true
      })
    window.api.pty.listSessionInventory = listSessionInventory
    const { result } = renderHook(() => useResourceSessionInventory(true, true))

    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))
    expect(result.current.sessionInventory.sessions).toEqual([
      { id: retainedId, cwd: '', title: retainedId, agentOwnership: 'unknown' }
    ])
    expect(result.current.sessionsError).toBe(true)
    expect(listSessions).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.sessionInventory.count).toBe(0)
    expect(result.current.sessionInventory.sessions).toEqual([])
    expect(result.current.sessionsError).toBe(false)
    expect(listSessionInventory).toHaveBeenCalledTimes(2)
  })

  it('falls back conservatively when a new preload invokes an old main', async () => {
    const unsupportedInventory = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'pty:listSessionInventory': Error: No handler registered for 'pty:listSessionInventory'"
      )
    })
    window.api.pty.listSessionInventory = unsupportedInventory
    const refreshedLocalSession = { ...session('local-session'), title: 'refreshed' }
    listSessions
      .mockResolvedValueOnce([session('local-session')])
      .mockResolvedValueOnce([refreshedLocalSession])
    const { result, rerender } = renderHook(({ open }) => useResourceSessionInventory(true, open), {
      initialProps: { open: false }
    })
    await waitFor(() => expect(result.current.sessionsError).toBe(true))
    expect(listSessions).toHaveBeenCalledTimes(1)

    act(() => {
      spawnedCallback?.({
        id: 'ssh:ssh-old@@remote-session',
        hostId: 'ssh:ssh-old',
        isReattach: false
      })
    })
    expect(result.current.sessionInventory.count).toBe(2)

    rerender({ open: true })
    await waitFor(() =>
      expect(result.current.sessionInventory.sessions).toEqual([refreshedLocalSession])
    )
    expect(result.current.sessionInventory.count).toBe(2)
    expect(result.current.sessionsError).toBe(true)
    expect(listSessions).toHaveBeenCalledTimes(2)
    expect(unsupportedInventory).toHaveBeenCalledTimes(2)
  })

  it('retains a novel spawn that races the initial authoritative seed', async () => {
    const seed = deferred<DaemonSession[]>()
    listSessions.mockReturnValueOnce(seed.promise)
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1))

    act(() => {
      spawnedCallback?.({ id: 'raced', isReattach: false })
    })
    expect(result.current.sessionInventory.count).toBe(1)

    await act(async () => {
      seed.resolve([])
      await seed.promise
    })
    expect(result.current.sessionInventory.count).toBe(1)
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('filters an exit from an in-flight list without losing other new sessions', async () => {
    listSessions.mockResolvedValueOnce([session('one'), session('exited')])
    const { result } = renderHook(() => useResourceSessionInventory(true, true))
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
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
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

  it('re-reads the inventory once when a management kill invalidates it without a pty exit', async () => {
    listSessions
      .mockResolvedValueOnce([session('one'), session('two')])
      .mockResolvedValue([session('one')])
    const { result } = renderHook(() => useResourceSessionInventory(true, false))
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(2))

    await act(async () => {
      notifyDaemonSessionInventoryInvalidated()
    })

    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('seeds exactly once after a daemon or runtime readiness restart', async () => {
    listSessions
      .mockResolvedValueOnce([session('before-restart')])
      .mockResolvedValueOnce([session('after-restart')])
    const { result, rerender } = renderHook(
      ({ ready }) => useResourceSessionInventory(ready, true),
      { initialProps: { ready: true } }
    )
    await waitFor(() => expect(result.current.sessionInventory.count).toBe(1))
    expect(listSessions).toHaveBeenCalledTimes(1)

    rerender({ ready: false })
    expect(result.current.sessionInventory.count).toBe(0)
    rerender({ ready: true })

    await waitFor(() =>
      expect(result.current.sessionInventory.sessions).toEqual([session('after-restart')])
    )
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('ignores inventory invalidation before session restore is ready and after unmount', async () => {
    listSessions.mockResolvedValue([session('one')])
    const { unmount } = renderHook(({ ready }) => useResourceSessionInventory(ready, false), {
      initialProps: { ready: false }
    })

    await act(async () => {
      notifyDaemonSessionInventoryInvalidated()
    })
    expect(listSessions).not.toHaveBeenCalled()

    unmount()
    await act(async () => {
      notifyDaemonSessionInventoryInvalidated()
    })
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('unsubscribes from lifecycle events on unmount', () => {
    listSessions.mockResolvedValue([])
    const { unmount } = renderHook(() => useResourceSessionInventory(true, false))

    unmount()

    expect(unsubscribeSpawned).toHaveBeenCalledTimes(1)
    expect(unsubscribeExit).toHaveBeenCalledTimes(1)
  })
})

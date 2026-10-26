// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyListedSession, PtySessionLifecycle } from '../../../../shared/pty-listed-session'
import { notifyDaemonSessionInventoryInvalidated } from './daemon-session-inventory-invalidation'
import { useResourceSessionInventory } from './use-resource-session-inventory'

const row = (id: string, incarnationId = 'A'): PtyListedSession => ({
  id,
  incarnationId,
  title: id,
  cwd: '/workspace',
  agentOwnership: 'absent',
  fencedTermination: true
})
function deferred() {
  let resolve!: (rows: PtyListedSession[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<PtyListedSession[]>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const list = vi.fn<() => Promise<PtyListedSession[]>>()
const spawned = new Set<(event: PtySessionLifecycle) => void>()
type SessionExit = PtySessionLifecycle & { code: number; ptySourceDisowned?: true }
const exited = new Set<(event: SessionExit) => void>()
const spawn = (event: PtySessionLifecycle) => spawned.forEach((listener) => listener(event))
const exit = (event: PtySessionLifecycle & { code?: number; ptySourceDisowned?: true }) =>
  exited.forEach((listener) => listener({ code: 0, ...event }))
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
function setup(active = false) {
  return renderHook(({ active, ready }) => useResourceSessionInventory(ready, active, true), {
    initialProps: { active, ready: true }
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  list.mockReset().mockResolvedValue([row('one')])
  vi.stubGlobal('api', {
    pty: {
      listSessions: list,
      onSpawned: (callback: (event: PtySessionLifecycle) => void) => {
        spawned.add(callback)
        return () => spawned.delete(callback)
      },
      onExit: (callback: (event: SessionExit) => void) => {
        exited.add(callback)
        return () => exited.delete(callback)
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Resource Manager inventory admission', () => {
  it('does no startup, closed, management or lifecycle diagnostic work', async () => {
    const { result } = setup()
    act(() => {
      spawn({ id: 'new', hostId: 'local' })
      notifyDaemonSessionInventoryInvalidated()
      void result.current.refreshSessions()
    })
    await flush(60_000)
    expect(list).not.toHaveBeenCalled()
    expect(result.current.observedAt).toBeNull()
    expect(result.current.sessionsError).toBe(false)
  })

  it('uses the explicit local scope and caches a successful empty inventory', async () => {
    list.mockResolvedValue([])
    const { result, rerender } = setup(true)
    await flush()
    expect(list).toHaveBeenCalledWith(
      { connectionId: null, includeUnrouted: true },
      { resourceManagerView: true }
    )
    expect(result.current.observedAt).not.toBeNull()
    rerender({ active: false, ready: true })
    rerender({ active: true, ready: true })
    await flush()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps Resources provider scope separate from local PTYs', async () => {
    const { result, rerender } = renderHook(
      ({ resources }) => ({
        resources: useResourceSessionInventory(true, resources),
        local: useResourceSessionInventory(true, !resources, true)
      }),
      { initialProps: { resources: true } }
    )
    await flush()
    expect(list).toHaveBeenCalledWith(undefined, { resourceManagerView: true })
    const baseline = result.current.resources.sessionInventory
    list.mockResolvedValue([row('local')])
    rerender({ resources: false })
    await flush()
    expect(result.current.resources.sessionInventory).toBe(baseline)
    expect(result.current.local.sessionInventory.sessions).toEqual([row('local')])
  })

  it('does not react to remote lifecycle events or fetch for untagged ones', async () => {
    setup(true)
    await flush()
    act(() => {
      spawn({ id: 'remote', hostId: 'ssh:host' })
      spawn({ id: 'unknown' })
      exit({ id: 'one', incarnationId: 'A', hostId: 'runtime:host' })
    })
    await flush(10_000)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('discards a hidden epoch and reconciles exactly once without overlap', async () => {
    const slow = deferred()
    list.mockReturnValueOnce(slow.promise).mockResolvedValue([row('new')])
    const { result, rerender } = setup(true)
    await flush()
    for (let i = 0; i < 5; i++) {
      rerender({ active: false, ready: true })
      rerender({ active: true, ready: true })
    }
    act(() => {
      void result.current.refreshSessions()
      notifyDaemonSessionInventoryInvalidated()
    })
    expect(list).toHaveBeenCalledTimes(1)
    await act(async () => {
      slow.resolve([row('old')])
      await slow.promise
    })
    expect(result.current.sessionInventory.count).toBe(0)
    await flush(100)
    expect(list).toHaveBeenCalledTimes(2)
    expect(result.current.sessionInventory.sessions).toEqual([row('new')])
  })

  it('does not let a previous epoch’s native veto cancel a newly visible epoch', async () => {
    const slow = deferred()
    list.mockReturnValueOnce(slow.promise).mockResolvedValue([row('current')])
    const { result, rerender } = setup(true)
    await flush()
    rerender({ active: false, ready: true })
    rerender({ active: true, ready: true })
    await act(async () => {
      slow.reject(new Error('view_not_visible'))
      await slow.promise.catch(() => {})
    })
    await flush(100)
    expect(list).toHaveBeenCalledTimes(2)
    expect(result.current.sessionInventory.sessions).toEqual([row('current')])
    expect(result.current.sessionsError).toBe(false)
  })

  it('cancels queued reconciliation when the view closes again', async () => {
    const slow = deferred()
    list.mockReturnValue(slow.promise)
    const { result, rerender } = setup(true)
    await flush()
    rerender({ active: false, ready: true })
    rerender({ active: true, ready: true })
    rerender({ active: false, ready: true })
    await act(async () => {
      slow.resolve([row('late')])
      await slow.promise
    })
    await flush(60_000)
    expect(list).toHaveBeenCalledTimes(1)
    expect(result.current.observedAt).toBeNull()
    expect(result.current.sessionInventory.count).toBe(0)
  })

  it('coalesces refresh bursts and has no periodic PTY polling', async () => {
    const { result } = setup(true)
    await flush()
    act(() => {
      for (let i = 0; i < 50; i++) {
        void result.current.refreshSessions()
      }
    })
    await flush(100)
    expect(list).toHaveBeenCalledTimes(2)
    await flush(60_000)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('retains failed observations, suppresses native visibility veto errors, and permits Retry', async () => {
    const { result } = setup(true)
    await flush()
    list.mockRejectedValueOnce(new Error('local unavailable'))
    act(() => {
      void result.current.refreshSessions()
    })
    await flush(100)
    expect(result.current.sessionsError).toBe(true)
    expect(result.current.sessionInventory.sessions).toEqual([row('one')])
    list.mockResolvedValueOnce([row('two')])
    act(() => {
      void result.current.refreshSessions()
    })
    await flush(100)
    expect(result.current.sessionsError).toBe(false)
    list.mockRejectedValueOnce(new Error('view_not_visible'))
    act(() => {
      void result.current.refreshSessions()
    })
    await flush(100)
    expect(result.current.sessionsError).toBe(false)
    expect(result.current.sessionInventory.sessions).toEqual([row('two')])
    act(() => {
      void result.current.refreshSessions()
    })
    await flush(100)
    expect(result.current.sessionInventory.sessions).toEqual([row('one')])
  })

  it('fences late exits and removals by incarnation', async () => {
    const { result } = setup(true)
    await flush()
    act(() => exit({ id: 'one', incarnationId: 'A', hostId: 'local' }))
    expect(result.current.sessionInventory.count).toBe(0)
    list.mockResolvedValue([row('one', 'B')])
    act(() => spawn({ id: 'one', incarnationId: 'B', hostId: 'local' }))
    await flush(100)
    act(() => exit({ id: 'one', incarnationId: 'A', hostId: 'local' }))
    expect(result.current.sessionInventory.sessions).toEqual([row('one', 'B')])
    act(() => exit({ id: 'one', hostId: 'local' }))
    expect(result.current.sessionInventory.count).toBe(1)
    act(() => result.current.removeSession('one', 'A'))
    expect(result.current.sessionInventory.count).toBe(1)
  })

  it('retains both daemon generations and removes only the exited incarnation', async () => {
    list.mockResolvedValue([row('one', 'A'), row('one', 'B'), row('unrelated')])
    const { result } = setup(true)
    await flush()
    expect(result.current.sessionsError).toBe(false)
    expect(result.current.sessionInventory.count).toBe(3)
    act(() => exit({ id: 'one', incarnationId: 'A', hostId: 'local' }))
    expect(result.current.sessionInventory.sessions).toEqual([row('one', 'B'), row('unrelated')])
    act(() => result.current.removeSession('one', 'A'))
    expect(result.current.sessionInventory.count).toBe(2)
  })

  it('retains legacy sources and refreshes an exit that cannot identify its source', async () => {
    const first = {
      id: 'legacy',
      title: 'first',
      cwd: '/first',
      agentOwnership: 'unknown' as const,
      inventorySourceId: 'first',
      rootProcessId: 101
    }
    const second = { ...first, inventorySourceId: 'second', rootProcessId: 202 }
    list.mockResolvedValue([first, second])
    const { result } = setup(true)
    await flush()
    expect(result.current.sessionInventory.count).toBe(2)
    list.mockResolvedValue([second])
    act(() => exit({ id: 'legacy', hostId: 'local' }))
    expect(result.current.sessionInventory.count).toBe(2)
    await flush(100)
    expect(result.current.sessionInventory.sessions).toEqual([second])
  })

  it('matches incarnation lifecycle events to diagnostic source identities', async () => {
    const first = { ...row('one', 'A'), inventorySourceId: 'first' }
    const second = { ...row('one', 'B'), inventorySourceId: 'second' }
    list.mockResolvedValue([first, second])
    const { result } = setup(true)
    await flush()
    act(() => spawn({ id: 'one', incarnationId: 'A', hostId: 'local' }))
    await flush(100)
    expect(list).toHaveBeenCalledOnce()
    act(() => exit({ id: 'one', incarnationId: 'A', hostId: 'local' }))
    expect(result.current.sessionInventory.sessions).toEqual([second])
    act(() => result.current.removeSession('one', 'B'))
    expect(result.current.sessionInventory.count).toBe(0)
  })

  it('retains ambiguous same-incarnation sources until an authoritative refresh', async () => {
    const first = { ...row('one'), inventorySourceId: 'first' }
    const second = { ...row('one'), inventorySourceId: 'second' }
    list.mockResolvedValue([first, second])
    const { result } = setup(true)
    await flush()
    act(() => exit({ id: 'one', incarnationId: 'A', hostId: 'local' }))
    expect(result.current.sessionInventory.count).toBe(2)
    await flush(100)
    expect(result.current.sessionInventory.count).toBe(2)
  })

  it('does not suppress ambiguous diagnostic sources when exit precedes the first listing', async () => {
    const first = { ...row('one'), inventorySourceId: 'first' }
    const second = { ...row('one'), inventorySourceId: 'second' }
    const slow = deferred()
    list.mockReturnValueOnce(slow.promise).mockResolvedValue([second])
    const { result } = setup(true)
    await flush()
    act(() => exit({ id: 'one', incarnationId: 'A', hostId: 'local' }))
    await act(async () => {
      slow.resolve([first, second])
      await slow.promise
    })
    expect(result.current.sessionInventory.count).toBe(2)
    await flush(100)
    expect(result.current.sessionInventory.sessions).toEqual([second])
  })

  it('refreshes an unidentified legacy exit that arrives during the first listing', async () => {
    const first: PtyListedSession = {
      id: 'one',
      cwd: '/first',
      title: 'shell',
      agentOwnership: 'unknown',
      inventorySourceId: 'first'
    }
    const second = { ...first, inventorySourceId: 'second' }
    const slow = deferred()
    list.mockReturnValueOnce(slow.promise).mockResolvedValue([second])
    const { result } = setup(true)
    await flush()
    act(() => exit({ id: 'one', hostId: 'local' }))
    await act(async () => {
      slow.resolve([first, second])
      await slow.promise
    })
    expect(result.current.sessionInventory.count).toBe(2)
    await flush(100)
    expect(result.current.sessionInventory.sessions).toEqual([second])
  })

  it.each([{ code: -1 }, { code: 0, ptySourceDisowned: true as const }])(
    'retains the observation when transport loss does not prove exit: %j',
    async (unverified) => {
      const { result } = setup(true)
      await flush()
      act(() => exit({ id: 'one', incarnationId: 'A', hostId: 'local', ...unverified }))
      expect(result.current.sessionInventory.sessions).toEqual([row('one')])
      await flush(10_000)
      expect(list).toHaveBeenCalledOnce()
    }
  )

  it('suppresses an exited incarnation only in the listing that could predate its exit', async () => {
    const slow = deferred()
    list.mockReturnValueOnce(slow.promise).mockResolvedValue([row('one')])
    const { result } = setup(true)
    await flush()
    act(() => exit({ id: 'one', incarnationId: 'A', hostId: 'local' }))
    await act(async () => {
      slow.resolve([row('one')])
      await slow.promise
    })
    expect(result.current.sessionInventory.count).toBe(0)
    act(() => {
      void result.current.refreshSessions()
    })
    await flush(100)
    expect(list).toHaveBeenCalledTimes(2)
    expect(result.current.sessionInventory.sessions).toEqual([row('one')])
  })
})

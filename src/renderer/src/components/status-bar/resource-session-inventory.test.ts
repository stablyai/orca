import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyListedSession as DaemonSession } from '../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { ResourceSessionInventoryCache } from './resource-session-inventory-cache'

function session(id: string, incarnationId?: string): DaemonSession {
  return { id, incarnationId, cwd: '/workspace', title: id, agentOwnership: 'absent' as const }
}

function deferredListing() {
  let resolve!: (sessions: DaemonSession[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<DaemonSession[]>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('resource session inventory request-scoped exits', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('associates loading notifications with the request they can invalidate', async () => {
    const original = session('one', 'A')
    const list = vi.fn().mockResolvedValue([original])
    const cache = new ResourceSessionInventoryCache(list, true)
    let exited = false
    cache.subscribe(() => {
      if (!exited && cache.getSnapshot().loading) {
        exited = true
        cache.exited({ code: 0, ...original, hostId: 'local' })
      }
    })

    cache.setActive(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(1)
    expect(cache.getSnapshot().sessionInventory.count).toBe(0)
  })

  it('absorbs pending exit publications into an in-flight listing without resurrecting its incarnation', async () => {
    const original = session('one', 'A')
    const replacement = session('one', 'B')
    const slow = deferredListing()
    const list = vi.fn().mockResolvedValueOnce([original]).mockReturnValueOnce(slow.promise)
    const cache = new ResourceSessionInventoryCache(list, true)
    cache.setActive(true)
    await vi.advanceTimersByTimeAsync(100)
    void cache.refresh()
    await vi.advanceTimersByTimeAsync(0)

    cache.exited({ code: 0, ...original, hostId: 'local' })
    slow.resolve([original, replacement])
    await vi.advanceTimersByTimeAsync(0)
    const settled = cache.getSnapshot().sessionInventory
    expect(settled.sessions).toEqual([replacement])
    await vi.advanceTimersByTimeAsync(50)
    expect(cache.getSnapshot().sessionInventory).toBe(settled)
    expect(vi.getTimerCount()).toBe(0)
  })
})

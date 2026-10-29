import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_DAEMON_SESSION_INVENTORY,
  inventoryFromSessions,
  removeSessionFromInventory,
  removeSessionsFromInventory
} from './resource-session-inventory'
import type { DaemonSession } from './resource-usage-merge-types'
import { ResourceSessionInventoryCache } from './resource-session-inventory-cache'

function session(id: string, incarnationId?: string): DaemonSession {
  return { id, incarnationId, cwd: '/workspace', title: id, agentOwnership: 'absent' as const }
}

describe('resource session inventory', () => {
  it('builds count from daemon listSessions payloads', () => {
    const inventory = inventoryFromSessions([session('a'), session('b')])
    expect(inventory.count).toBe(2)
    expect(inventory.sessions.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('returns a detached sessions array so callers can mutate safely', () => {
    const source = [session('a')]
    const inventory = inventoryFromSessions(source)
    source.pop()
    expect(inventory.sessions).toEqual([session('a')])
    expect(inventory.count).toBe(1)
  })

  it('removes killed or exited sessions without inventing wake-hint ids', () => {
    const start = inventoryFromSessions([session('live'), session('orphan'), session('other')])
    const afterOne = removeSessionFromInventory(start, 'orphan')
    expect(afterOne.count).toBe(2)
    expect(afterOne.sessions.map((entry) => entry.id)).toEqual(['live', 'other'])

    const afterMany = removeSessionsFromInventory(start, new Set(['live', 'missing', 'other']))
    expect(afterMany).toEqual(inventoryFromSessions([session('orphan')]))
  })

  it('is a no-op when removed ids are absent', () => {
    const start = inventoryFromSessions([session('live')])
    expect(removeSessionFromInventory(start, 'gone')).toBe(start)
    expect(removeSessionsFromInventory(start, new Set())).toBe(start)
    expect(EMPTY_DAEMON_SESSION_INVENTORY.count).toBe(0)
  })
})

function deferredListing() {
  let resolve!: (sessions: DaemonSession[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<DaemonSession[]>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const removableExitCases = [
  { localOnly: false, incarnationId: undefined },
  { localOnly: false, incarnationId: 'A' },
  { localOnly: true, incarnationId: 'A' }
]

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

  it.each(removableExitCases)(
    'suppresses an in-flight exit only until that listing settles: $incarnationId (localOnly=$localOnly)',
    async ({ incarnationId, localOnly }) => {
      const original = session('one', incarnationId)
      const slow = deferredListing()
      const list = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue([original])
      const cache = new ResourceSessionInventoryCache(list, localOnly)
      cache.setActive(true)
      await vi.advanceTimersByTimeAsync(0)

      cache.exited({ code: 0, id: original.id, incarnationId, hostId: 'local' })
      slow.resolve([original])
      await vi.advanceTimersByTimeAsync(0)
      expect(cache.getSnapshot().sessionInventory.count).toBe(0)

      void cache.refresh()
      await vi.advanceTimersByTimeAsync(100)
      expect(cache.getSnapshot().sessionInventory.sessions).toEqual([original])
      expect(list).toHaveBeenCalledTimes(2)
    }
  )

  it.each(removableExitCases)(
    'does not suppress authoritative results after an idle exit: $incarnationId (localOnly=$localOnly)',
    async ({ incarnationId, localOnly }) => {
      const original = session('one', incarnationId)
      const list = vi.fn().mockResolvedValue([original])
      const cache = new ResourceSessionInventoryCache(list, localOnly)
      cache.setActive(true)
      await vi.advanceTimersByTimeAsync(0)

      cache.exited({ code: 0, id: original.id, incarnationId, hostId: 'local' })
      expect(cache.getSnapshot().sessionInventory.count).toBe(0)
      cache.invalidate()
      await vi.advanceTimersByTimeAsync(100)
      expect(cache.getSnapshot().sessionInventory.sessions).toEqual([original])
    }
  )

  it.each(removableExitCases)(
    'keeps a replacement incarnation visible in the same listing as an exit: $incarnationId (localOnly=$localOnly)',
    async ({ incarnationId, localOnly }) => {
      const original = session('one', incarnationId)
      const replacement = session('one', 'B')
      const slow = deferredListing()
      const cache = new ResourceSessionInventoryCache(() => slow.promise, localOnly)
      cache.setActive(true)
      await vi.advanceTimersByTimeAsync(0)

      cache.exited({ code: 0, id: original.id, incarnationId, hostId: 'local' })
      slow.resolve([replacement, original])
      await vi.advanceTimersByTimeAsync(0)
      expect(cache.getSnapshot().sessionInventory.sessions).toEqual([replacement])
    }
  )

  it('retires suppression before dispatching an already queued refresh', async () => {
    const original = [session('one', 'A'), session('legacy')]
    const slow = deferredListing()
    const list = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(original)
    const cache = new ResourceSessionInventoryCache(list, true)
    cache.setActive(true)
    await vi.advanceTimersByTimeAsync(100)
    void cache.refresh()
    for (const entry of original) {
      cache.exited({ code: 0, ...entry, hostId: 'local' })
    }

    slow.resolve(original)
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(2)
    expect(cache.getSnapshot().sessionInventory.sessions).toEqual(original)
  })

  it.each(['unavailable', 'view_not_visible'])(
    'retires suppression after a failed listing: %s',
    async (message) => {
      const original = [session('one', 'A'), session('legacy')]
      const slow = deferredListing()
      const list = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(original)
      const cache = new ResourceSessionInventoryCache(list, true)
      cache.setActive(true)
      await vi.advanceTimersByTimeAsync(0)
      for (const entry of original) {
        cache.exited({ code: 0, ...entry, hostId: 'local' })
      }

      slow.reject(new Error(message))
      await vi.advanceTimersByTimeAsync(0)
      expect(cache.getSnapshot().sessionsError).toBe(message === 'unavailable')
      expect(cache.getSnapshot().sessionInventory.count).toBe(0)
      cache.setActive(false)
      cache.setActive(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(cache.getSnapshot().sessionsError).toBe(false)
      expect(cache.getSnapshot().sessionInventory.sessions).toEqual(original)
    }
  )

  it('retires exits from a discarded epoch before reconciling a reopened view', async () => {
    const original = [session('one', 'A'), session('legacy')]
    const slow = deferredListing()
    const list = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(original)
    const cache = new ResourceSessionInventoryCache(list, true)
    cache.setActive(true)
    await vi.advanceTimersByTimeAsync(0)
    cache.setActive(false)
    for (const entry of original) {
      cache.exited({ code: 0, ...entry, hostId: 'local' })
    }
    cache.setActive(true)

    slow.resolve(original)
    await vi.advanceTimersByTimeAsync(0)
    expect(cache.getSnapshot().observedAt).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(cache.getSnapshot().sessionInventory.sessions).toEqual(original)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('batch-removes matching identities once and fences only their in-flight result', async () => {
    const original = session('one', 'A')
    const legacy = session('legacy')
    const replacement = session('replacement', 'B')
    const missing = session('missing', 'C')
    const rows = [original, legacy, replacement, missing]
    const slow = deferredListing()
    const list = vi
      .fn()
      .mockResolvedValueOnce([original, legacy, replacement])
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(rows)
    const cache = new ResourceSessionInventoryCache(list, true)
    cache.setActive(true)
    await vi.advanceTimersByTimeAsync(100)
    void cache.refresh()
    await vi.advanceTimersByTimeAsync(0)
    const changed = vi.fn()
    cache.subscribe(changed)

    cache.removeMany([original, legacy, missing, session(replacement.id, 'A')])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(cache.getSnapshot().sessionInventory.sessions).toEqual([replacement])
    slow.resolve([...rows, session(replacement.id, 'A')])
    await vi.advanceTimersByTimeAsync(0)
    expect(cache.getSnapshot().sessionInventory.sessions).toEqual([replacement])

    void cache.refresh()
    await vi.advanceTimersByTimeAsync(100)
    expect(cache.getSnapshot().sessionInventory.sessions).toEqual(rows)
  })
})

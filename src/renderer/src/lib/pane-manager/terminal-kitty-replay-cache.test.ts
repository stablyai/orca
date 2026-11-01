import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createKittyReplayCache,
  pruneKittyReplayRecords,
  type KittyImageSnapshot,
  type KittyReplayStore
} from './terminal-kitty-replay-cache'

function snapshot(id = 7, bytes = 10): KittyImageSnapshot {
  return {
    image: {
      id,
      data: new Blob([new Uint8Array(bytes)]),
      width: 1,
      height: 1,
      format: 100,
      compression: ''
    },
    placements: [{ placementId: 0, cols: 2, rows: 2, command: { unicodePlaceholder: 1 } }]
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Kitty image replay cache', () => {
  it('keeps the cache usable when the window only exposes a host bridge', async () => {
    vi.stubGlobal('window', { api: {} })
    vi.resetModules()
    const { createKittyReplayCache: createCache } = await import('./terminal-kitty-replay-cache')
    const records = new Map<string, KittyImageSnapshot>()
    const cache = createCache({
      read: async (scope, id) => records.get(`${scope}/${id}`),
      write: async (changes) => {
        for (const { scope, id, record } of changes) {
          if (record) {
            records.set(`${scope}/${id}`, record.snapshot)
          }
        }
      }
    })
    cache.save('pane', 7, snapshot())
    expect(await cache.read('pane', 7)).toEqual(snapshot())
  })

  it('coalesces writes and applies deletion before a subsequent read', async () => {
    vi.useFakeTimers()
    const records = new Map<string, KittyImageSnapshot>()
    const store: KittyReplayStore = {
      read: vi.fn(async (scope, id) => records.get(`${scope}/${id}`)),
      write: vi.fn(async (changes) => {
        for (const { scope, id, record } of changes) {
          if (record) {
            records.set(`${scope}/${id}`, record.snapshot)
          } else {
            records.delete(`${scope}/${id}`)
          }
        }
      })
    }
    const cache = createKittyReplayCache(store)
    cache.save('first', 7, snapshot())
    cache.save('first', 7, snapshot())
    expect(await cache.read('first', 7)).toBeDefined()
    expect(store.write).toHaveBeenCalledTimes(1)
    cache.save('first', 7)
    expect(await cache.read('first', 7)).toBeUndefined()
  })

  it('keeps equal image IDs in different terminal scopes separate', async () => {
    const write = vi.fn<KittyReplayStore['write']>(async () => {})
    const cache = createKittyReplayCache({ read: async () => undefined, write })
    cache.save('host-a/pty-a', 7, snapshot())
    cache.save('host-b/pty-a', 7, snapshot())
    await cache.flush()
    expect(write.mock.calls[0]?.[0]).toHaveLength(2)
  })

  it.each(['deletion', 'replacement'])(
    'does not read the old snapshot after a failed %s write',
    async (operation) => {
      const old = snapshot()
      const unrelated = snapshot(8)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const read = vi.fn(async (_scope: string, id: number) => (id === 7 ? old : unrelated))
      const cache = createKittyReplayCache({
        read,
        write: async () => {
          throw new Error('controlled image write failure')
        }
      })
      try {
        cache.save('pane', 7, operation === 'replacement' ? snapshot(7, 11) : undefined)
        await cache.flush()
        expect(await cache.read('pane', 7)).toBeUndefined()
        expect(await cache.read('pane', 8)).toBe(unrelated)
        expect(read).toHaveBeenCalledTimes(1)
        expect(read).toHaveBeenCalledWith('pane', 8)
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    }
  )

  it('rejects a lookup invalidated while its old store read is in flight', async () => {
    const started = Promise.withResolvers<void>()
    const result = Promise.withResolvers<KittyImageSnapshot | undefined>()
    const cache = createKittyReplayCache({
      read: async () => {
        started.resolve()
        return result.promise
      },
      write: async () => {}
    })
    const lookup = cache.read('pane', 7)
    await started.promise
    cache.save('pane', 7)
    await cache.flush()
    result.resolve(snapshot())
    expect(await lookup).toBeUndefined()
  })

  it('keeps a failed newer deletion blocked when an older write finishes', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const records = new Map<number, KittyImageSnapshot>([[7, snapshot()]])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let writes = 0
    const cache = createKittyReplayCache({
      read: async (_scope, id) => records.get(id),
      write: async (changes) => {
        if (++writes !== 1) {
          throw new Error('controlled later invalidation failure')
        }
        started.resolve()
        await release.promise
        for (const change of changes) {
          if (change.record) {
            records.set(change.id, change.record.snapshot)
          }
        }
      }
    })
    try {
      cache.save('pane', 7, snapshot(7, 11))
      const first = cache.flush()
      await started.promise
      cache.save('pane', 7)
      const second = cache.flush()
      release.resolve()
      await Promise.all([first, second])
      expect(await cache.read('pane', 7)).toBeUndefined()
      expect(writes).toBe(2)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      warn.mockRestore()
    }
  })

  it('strips transport filenames and payloads from persisted placement commands', async () => {
    const write = vi.fn<KittyReplayStore['write']>(async () => {})
    const cache = createKittyReplayCache({ read: async () => undefined, write })
    const image = snapshot()
    Object.assign(image.placements[0]!.command, {
      payload: '/private/source.png',
      transmission: 'f'
    })
    cache.save('pane', 7, image)
    await cache.flush()
    expect(write.mock.calls[0]?.[0][0]?.record?.snapshot.placements[0]?.command).toEqual({
      unicodePlaceholder: 1
    })
  })

  it('rejects mismatched IDs and oversized payloads', async () => {
    const write = vi.fn<KittyReplayStore['write']>(async () => {})
    const cache = createKittyReplayCache({ read: async () => undefined, write })
    cache.save('pane', 7, snapshot(8))
    cache.save('pane', 9, snapshot(9, 8 * 1024 * 1024 + 1))
    await cache.flush()
    expect(write.mock.calls[0]?.[0].every((change) => !change.record)).toBe(true)
  })

  it('evicts expired records and bounds each pane independently of the global cache', () => {
    const now = 10 * 24 * 60 * 60 * 1000
    const records = Array.from({ length: 20 }, (_, id) => ({
      scope: id < 6 ? 'first' : `pane-${id}`,
      id,
      touched: now - id,
      bytes: 8 * 1024 * 1024
    }))
    const removed = pruneKittyReplayRecords(records, now)
    expect(removed.map((record) => record.id)).toEqual([4, 5, 18, 19])
    expect(pruneKittyReplayRecords([{ ...records[0]!, touched: 0 }], now)).toHaveLength(1)
  })

  it('does not block live rendering when storage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cache = createKittyReplayCache({
      read: async () => {
        throw new Error('disabled')
      },
      write: async () => {
        throw new Error('quota')
      }
    })
    try {
      cache.save('pane', 7, snapshot())
      expect(await cache.read('pane', 7)).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

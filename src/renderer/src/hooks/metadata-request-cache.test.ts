import { describe, expect, it, vi } from 'vitest'
import {
  clearMetadataRequestStore,
  createMetadataRequestStore,
  getFreshMetadata,
  loadMetadata,
  MAX_METADATA_ERROR_SUMMARY_BYTES,
  MAX_METADATA_INFLIGHT_ENTRIES,
  MAX_METADATA_KEY_BYTES,
  MAX_METADATA_VALUE_BYTES
} from './metadata-request-cache'

describe('metadata-request-cache', () => {
  it('dedupes concurrent requests for the same cache key', async () => {
    const store = createMetadataRequestStore<string[]>()
    let resolveRequest: (value: string[]) => void = () => {}
    const fetcher = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveRequest = resolve
        })
    )

    const first = loadMetadata(store, 'repo:labels', fetcher, () => 1_000)
    const second = loadMetadata(store, 'repo:labels', fetcher, () => 1_000)

    expect(fetcher).toHaveBeenCalledTimes(1)

    resolveRequest(['bug'])
    await expect(Promise.all([first, second])).resolves.toEqual([['bug'], ['bug']])

    const cached = await loadMetadata(
      store,
      'repo:labels',
      () => Promise.resolve(['should-not-fetch']),
      () => 1_100
    )
    expect(cached).toEqual(['bug'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps different cache keys isolated', async () => {
    const store = createMetadataRequestStore<string[]>()
    const fetcher = vi.fn((key: string) => Promise.resolve([key]))

    await Promise.all([
      loadMetadata(store, 'repo-a:labels', () => fetcher('a')),
      loadMetadata(store, 'repo-b:labels', () => fetcher('b'))
    ])

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(getFreshMetadata(store, 'repo-a:labels')?.data).toEqual(['a'])
    expect(getFreshMetadata(store, 'repo-b:labels')?.data).toEqual(['b'])
  })

  it('paces failed requests with a short negative TTL instead of refetching immediately', async () => {
    const store = createMetadataRequestStore<string[]>()
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(['triage'])

    await expect(loadMetadata(store, 'repo:labels', fetcher, () => 1_000)).rejects.toThrow(
      'network'
    )
    // Within the failure TTL the cached rejection is reused without a fetch.
    await expect(loadMetadata(store, 'repo:labels', fetcher, () => 2_000)).rejects.toThrow(
      'network'
    )
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Past the failure TTL the key becomes fetchable again.
    await expect(loadMetadata(store, 'repo:labels', fetcher, () => 11_000)).resolves.toEqual([
      'triage'
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('a success clears the remembered failure for its key', async () => {
    const store = createMetadataRequestStore<string[]>()
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(['triage'])

    await expect(loadMetadata(store, 'repo:labels', fetcher, () => 1_000)).rejects.toThrow(
      'network'
    )
    await expect(loadMetadata(store, 'repo:labels', fetcher, () => 12_000)).resolves.toEqual([
      'triage'
    ])
    expect(store.failures.has('repo:labels')).toBe(false)
  })

  it('keeps failure entries isolated per key', async () => {
    const store = createMetadataRequestStore<string[]>()
    await expect(
      loadMetadata(
        store,
        'repo-a:labels',
        () => Promise.reject(new Error('down')),
        () => 1_000
      )
    ).rejects.toThrow('down')

    const fetcherB = vi.fn(() => Promise.resolve(['ok']))
    await expect(loadMetadata(store, 'repo-b:labels', fetcherB, () => 1_000)).resolves.toEqual([
      'ok'
    ])
    expect(fetcherB).toHaveBeenCalledTimes(1)
  })

  it('bounds retained failure entries', async () => {
    const store = createMetadataRequestStore<string[]>()

    for (let index = 0; index <= 200; index += 1) {
      await expect(
        loadMetadata(
          store,
          `repo-${index}:labels`,
          () => Promise.reject(new Error(`down-${index}`)),
          () => index
        )
      ).rejects.toThrow(`down-${index}`)
    }

    expect(store.failures.size).toBe(200)
    expect(store.failures.has('repo-0:labels')).toBe(false)
    expect(store.failures.has('repo-200:labels')).toBe(true)
  })

  it('does not record failures from a cleared generation', async () => {
    const store = createMetadataRequestStore<string[]>()
    let rejectRequest: (error: Error) => void = () => {}
    const pending = loadMetadata(
      store,
      'repo:labels',
      () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectRequest = reject
        }),
      () => 1_000
    )

    clearMetadataRequestStore(store)
    rejectRequest(new Error('stale failure'))
    await expect(pending).rejects.toThrow('stale failure')
    expect(store.failures.size).toBe(0)
    expect(store.retainedBytes).toBe(0)

    const fetcher = vi.fn(() => Promise.resolve(['fresh']))
    await expect(loadMetadata(store, 'repo:labels', fetcher, () => 1_500)).resolves.toEqual([
      'fresh'
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not let stale in-flight responses repopulate after clear', async () => {
    const store = createMetadataRequestStore<string[]>()
    let resolveRequest: (value: string[]) => void = () => {}

    const pending = loadMetadata(
      store,
      'team:members',
      () =>
        new Promise<string[]>((resolve) => {
          resolveRequest = resolve
        }),
      () => 1_000
    )

    clearMetadataRequestStore(store)
    resolveRequest(['old-user'])

    await expect(pending).resolves.toEqual(['old-user'])
    expect(getFreshMetadata(store, 'team:members', 1_100)).toBeNull()
    expect(store.retainedBytes).toBe(0)
  })

  it('does not let a cleared request release a newer request for the same key', async () => {
    const store = createMetadataRequestStore<string>()
    let resolveStale: (value: string) => void = () => {}
    let resolveCurrent: (value: string) => void = () => {}
    const stale = loadMetadata(
      store,
      'same',
      () =>
        new Promise<string>((resolve) => {
          resolveStale = resolve
        })
    )

    clearMetadataRequestStore(store)
    const current = loadMetadata(
      store,
      'same',
      () =>
        new Promise<string>((resolve) => {
          resolveCurrent = resolve
        })
    )

    resolveStale('stale')
    await expect(stale).resolves.toBe('stale')
    expect(store.inflight.has('same')).toBe(true)
    expect(store.retainedBytes).toBe(4)

    resolveCurrent('current')
    await expect(current).resolves.toBe('current')
    expect(store.cache.get('same')?.data).toBe('current')
    expect(store.retainedBytes).toBe(11)
  })

  it('prunes stale cache entries when they age past the metadata ttl', async () => {
    const store = createMetadataRequestStore<string[]>()

    await loadMetadata(
      store,
      'repo:labels',
      () => Promise.resolve(['bug']),
      () => 1_000
    )

    expect(store.cache.has('repo:labels')).toBe(true)
    expect(getFreshMetadata(store, 'repo:labels', 301_000)).toBeNull()
    expect(store.cache.has('repo:labels')).toBe(false)
  })

  it('bounds retained cache entries by newest fetch time', async () => {
    const store = createMetadataRequestStore<string[]>()

    for (let i = 0; i <= 500; i++) {
      await loadMetadata(
        store,
        `repo-${i}:labels`,
        () => Promise.resolve([`label-${i}`]),
        () => i
      )
    }

    expect(store.cache.size).toBe(500)
    expect(store.cache.has('repo-0:labels')).toBe(false)
    expect(store.cache.get('repo-500:labels')?.data).toEqual(['label-500'])
  })

  it('rejects distinct hung fetches beyond the in-flight bound', async () => {
    const store = createMetadataRequestStore<string[]>()
    const pending = Array.from({ length: MAX_METADATA_INFLIGHT_ENTRIES }, (_, index) =>
      loadMetadata(store, `repo-${index}:labels`, () => new Promise<string[]>(() => {}))
    )

    await expect(
      loadMetadata(store, 'overflow:labels', () => Promise.resolve(['unexpected']))
    ).rejects.toThrow('queue is full')
    expect(store.inflight.size).toBe(MAX_METADATA_INFLIGHT_ENTRIES)

    clearMetadataRequestStore(store)
    void pending
  })

  it('accepts an exact-limit key and rejects an oversized key before fetching', async () => {
    const store = createMetadataRequestStore<string>()
    const exactKey = '🙂'.repeat(MAX_METADATA_KEY_BYTES / 4)
    await expect(loadMetadata(store, exactKey, () => Promise.resolve(''))).resolves.toBe('')
    expect(store.cache.has(exactKey)).toBe(true)

    const fetcher = vi.fn(() => Promise.resolve('unexpected'))
    await expect(loadMetadata(store, `${exactKey}x`, fetcher)).rejects.toThrow(
      `exceeds ${MAX_METADATA_KEY_BYTES} bytes`
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retains an exact-limit value and lets an oversized value recover without retention', async () => {
    const exactStore = createMetadataRequestStore<string>()
    const exactValue = 'v'.repeat(MAX_METADATA_VALUE_BYTES)
    await expect(
      loadMetadata(exactStore, 'exact', () => Promise.resolve(exactValue))
    ).resolves.toBe(exactValue)
    expect(exactStore.cache.get('exact')?.data).toBe(exactValue)

    const oversizedStore = createMetadataRequestStore<string>()
    const oversizedValue = `${exactValue}x`
    await expect(
      loadMetadata(oversizedStore, 'recoverable', () => Promise.resolve(oversizedValue))
    ).resolves.toBe(oversizedValue)
    expect(oversizedStore.cache.has('recoverable')).toBe(false)

    await expect(
      loadMetadata(oversizedStore, 'recoverable', () => Promise.resolve('small'))
    ).resolves.toBe('small')
    expect(oversizedStore.cache.get('recoverable')?.data).toBe('small')
  })

  it('stores only an exact bounded error summary and reuses that summary', async () => {
    const store = createMetadataRequestStore<string>()
    const error = new Error('oversized remote failure')
    error.name = 'RemoteError'
    error.message = 'x'.repeat(MAX_METADATA_ERROR_SUMMARY_BYTES - error.name.length + 1_000)

    await expect(
      loadMetadata(
        store,
        'failure',
        () => Promise.reject(error),
        () => 1_000
      )
    ).rejects.toBe(error)

    const cached = store.failures.get('failure')
    expect((cached?.error.name.length ?? 0) + (cached?.error.message.length ?? 0)).toBe(
      MAX_METADATA_ERROR_SUMMARY_BYTES
    )
    expect(cached?.error.stack).toBeUndefined()
    await expect(
      loadMetadata(
        store,
        'failure',
        () => Promise.resolve('unexpected'),
        () => 1_001
      )
    ).rejects.toThrow(cached?.error.message)
  })

  it('fills the aggregate budget exactly and evicts oldest retained data for recovery', async () => {
    const store = createMetadataRequestStore<string>({ maxRetainedBytes: 20 })

    await loadMetadata(
      store,
      'a',
      () => Promise.resolve('x'.repeat(9)),
      () => 1
    )
    await loadMetadata(
      store,
      'b',
      () => Promise.resolve('y'.repeat(9)),
      () => 2
    )
    expect(store.retainedBytes).toBe(20)

    await loadMetadata(
      store,
      'c',
      () => Promise.resolve('z'.repeat(9)),
      () => 3
    )
    expect(store.retainedBytes).toBe(20)
    expect(store.cache.has('a')).toBe(false)
    expect(store.cache.has('b')).toBe(true)
    expect(store.cache.has('c')).toBe(true)
  })

  it('rejects in-flight aggregate overload and accepts work after memory is released', async () => {
    const store = createMetadataRequestStore<string>({ maxRetainedBytes: 4 })
    let resolveFirst: (value: string) => void = () => {}
    const first = loadMetadata(
      store,
      'aa',
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve
        })
    )
    const second = loadMetadata(store, 'bb', () => new Promise<string>(() => {}))

    expect(store.retainedBytes).toBe(4)
    await expect(loadMetadata(store, 'c', () => Promise.resolve(''))).rejects.toThrow(
      'memory budget is full'
    )

    resolveFirst('')
    await expect(first).resolves.toBe('')
    await expect(loadMetadata(store, 'c', () => Promise.resolve(''))).resolves.toBe('')
    expect(store.retainedBytes).toBeLessThanOrEqual(4)

    clearMetadataRequestStore(store)
    expect(store.retainedBytes).toBe(0)
    void second
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  clearMetadataRequestStore,
  createMetadataRequestStore,
  getFreshMetadata,
  loadMetadata
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

  it('does not cache failed requests', async () => {
    const store = createMetadataRequestStore<string[]>()
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(['triage'])

    await expect(loadMetadata(store, 'repo:labels', fetcher)).rejects.toThrow('network')
    await expect(loadMetadata(store, 'repo:labels', fetcher)).resolves.toEqual(['triage'])

    expect(fetcher).toHaveBeenCalledTimes(2)
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
  })
})

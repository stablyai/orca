import { describe, expect, it } from 'vitest'
import {
  clearMetadataRequestStore,
  createMetadataRequestStore,
  getFreshMetadata,
  loadMetadata
} from './metadata-request-cache'

describe('metadata-request-cache', () => {
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

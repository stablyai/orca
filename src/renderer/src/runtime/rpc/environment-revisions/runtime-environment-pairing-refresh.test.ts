import { afterEach, describe, expect, it, vi } from 'vitest'
import '../calls/runtime-rpc-environment-call'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  refreshRuntimeEnvironmentCatalog,
  setRuntimeEnvironmentCatalogRefresher
} from './runtime-environment-pairing-refresh'

afterEach(() => {
  setRuntimeEnvironmentCatalogRefresher(null)
  replaceRuntimeEnvironmentRevisions([])
  vi.unstubAllGlobals()
})

describe('catalog refresh coalescing', () => {
  it('reads again after an in-flight read that may predate the change', async () => {
    let catalog = ['env-1', 'env-recipe']
    const published: string[][] = []
    const releaseFirstRead = Promise.withResolvers<void>()
    let reads = 0
    setRuntimeEnvironmentCatalogRefresher(async () => {
      const snapshot = [...catalog]
      reads += 1
      if (reads === 1) {
        await releaseFirstRead.promise
      }
      published.push(snapshot)
    })

    const first = refreshRuntimeEnvironmentCatalog()
    // Recipe cleanup forgets the server while the earlier read is still out.
    catalog = ['env-1']
    const afterRemoval = refreshRuntimeEnvironmentCatalog()
    const sameBurst = refreshRuntimeEnvironmentCatalog()
    releaseFirstRead.resolve()
    await Promise.all([first, afterRemoval, sameBurst])

    expect(published.at(-1)).toEqual(['env-1'])
  })
})

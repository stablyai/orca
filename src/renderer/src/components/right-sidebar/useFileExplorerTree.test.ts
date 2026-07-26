import { describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { DirEntry } from '../../../../shared/types'
import type { DirCache } from './file-explorer-types'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import { refreshFileExplorerExpandedDirs } from './useFileExplorerTree'

type CacheUpdate = SetStateAction<Record<string, DirCache>>

function entry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory, isSymlink: false }
}

describe('refreshFileExplorerExpandedDirs', () => {
  it('reloads expanded directories with one loading cache commit and one result cache commit', async () => {
    let cache: Record<string, DirCache> = {
      '/repo': {
        children: [
          { name: 'old', path: '/repo/old', relativePath: 'old', isDirectory: false, depth: 0 }
        ],
        loading: false
      },
      '/repo/src': { children: [], loading: false },
      '/repo/docs': { children: [], loading: false }
    }
    const committedCaches: Record<string, DirCache>[] = []
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
      committedCaches.push(cache)
    })
    const readDirectory = vi.fn(async (dirPath: string) => {
      const entriesByPath: Record<string, DirEntry[]> = {
        '/repo/src': [entry('index.ts')],
        '/repo/docs': [entry('guide.md')]
      }
      return { entries: entriesByPath[dirPath] ?? [], operationOwner: { kind: 'local' as const } }
    })

    const refreshed = await refreshFileExplorerExpandedDirs({
      dirs: [
        { dirPath: '/repo/src', depth: 0 },
        { dirPath: '/repo/docs', depth: 0 }
      ],
      worktreePath: '/repo',
      dirLoadTracker: createFileExplorerDirLoadTracker(),
      setDirCache,
      readDirectory
    })

    expect(refreshed).toBe(true)
    expect(setDirCache).toHaveBeenCalledTimes(2)
    expect(committedCaches[0]).toMatchObject({
      '/repo': { loading: false, children: [{ name: 'old' }] },
      '/repo/src': { loading: true },
      '/repo/docs': { loading: true }
    })
    expect(committedCaches[1]).toMatchObject({
      '/repo': { loading: false, children: [{ name: 'old' }] },
      '/repo/src': {
        loading: false,
        children: [
          {
            name: 'index.ts',
            path: '/repo/src/index.ts',
            relativePath: 'src/index.ts',
            isDirectory: false,
            depth: 1
          }
        ]
      },
      '/repo/docs': {
        loading: false,
        children: [
          {
            name: 'guide.md',
            path: '/repo/docs/guide.md',
            relativePath: 'docs/guide.md',
            isDirectory: false,
            depth: 1
          }
        ]
      }
    })
    expect(readDirectory).toHaveBeenCalledTimes(2)
  })

  it('drops a superseded directory result so a newer concurrent load is not clobbered', async () => {
    const tracker = createFileExplorerDirLoadTracker()
    let cache: Record<string, DirCache> = {
      '/repo/src': { children: [], loading: false },
      '/repo/docs': { children: [], loading: false }
    }
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const newerSrcCache: DirCache = {
      loading: true,
      children: [
        {
          name: 'fresh.ts',
          path: '/repo/src/fresh.ts',
          relativePath: 'src/fresh.ts',
          isDirectory: false,
          depth: 1
        }
      ]
    }
    const readDirectory = vi.fn(async (dirPath: string) => {
      if (dirPath === '/repo/src') {
        // Simulate a concurrent newer load (e.g. a watcher-driven refreshDir)
        // superseding this directory while its refresh read is still in flight:
        // bump the load token and commit fresher children.
        tracker.begin('/repo/src')
        setDirCache((prev) => ({
          ...prev,
          '/repo/src': newerSrcCache
        }))
        return { entries: [entry('stale.ts')], operationOwner: { kind: 'local' as const } }
      }
      return { entries: [entry('guide.md')], operationOwner: { kind: 'local' as const } }
    })

    const refreshed = await refreshFileExplorerExpandedDirs({
      dirs: [
        { dirPath: '/repo/src', depth: 0 },
        { dirPath: '/repo/docs', depth: 0 }
      ],
      worktreePath: '/repo',
      dirLoadTracker: tracker,
      setDirCache,
      readDirectory
    })

    // Not every dir was still current, so the refresh reports partial completion.
    expect(refreshed).toBe(false)
    // The superseded dir keeps the newer load state; the stale read is
    // dropped from the batched commit instead of clobbering fresher data.
    expect(cache['/repo/src']).toEqual(newerSrcCache)
    // The still-current dir is committed normally.
    expect(cache['/repo/docs']).toMatchObject({
      loading: false,
      children: [{ name: 'guide.md' }]
    })
  })

  it('drops a result superseded after its read resolved but before the batch commit', async () => {
    const tracker = createFileExplorerDirLoadTracker()
    let cache: Record<string, DirCache> = {
      '/repo/src': { children: [], loading: false },
      '/repo/docs': { children: [], loading: false }
    }
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    let releaseDocs!: () => void
    const docsGate = new Promise<void>((resolve) => {
      releaseDocs = resolve
    })
    const readDirectory = vi.fn(async (dirPath: string) => {
      if (dirPath === '/repo/src') {
        return { entries: [entry('stale.ts')], operationOwner: { kind: 'local' as const } }
      }
      await docsGate
      return { entries: [entry('guide.md')], operationOwner: { kind: 'local' as const } }
    })

    const refreshPromise = refreshFileExplorerExpandedDirs({
      dirs: [
        { dirPath: '/repo/src', depth: 0 },
        { dirPath: '/repo/docs', depth: 0 }
      ],
      worktreePath: '/repo',
      dirLoadTracker: tracker,
      setDirCache,
      readDirectory
    })

    // Let /repo/src resolve (and pass its resolve-time token check) while
    // /repo/docs is still in flight — the batch commit is gated on docs.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A newer load (e.g. a watcher-driven refreshDir) supersedes /repo/src in
    // the window between its resolved read and the final batched commit.
    tracker.begin('/repo/src')
    const newerSrcCache: DirCache = {
      loading: false,
      children: [
        {
          name: 'fresh.ts',
          path: '/repo/src/fresh.ts',
          relativePath: 'src/fresh.ts',
          isDirectory: false,
          depth: 1
        }
      ]
    }
    setDirCache((prev) => ({ ...prev, '/repo/src': newerSrcCache }))

    releaseDocs()
    const refreshed = await refreshPromise

    expect(refreshed).toBe(false)
    // The stale /repo/src read must not clobber the newer committed cache.
    expect(cache['/repo/src']).toEqual(newerSrcCache)
    expect(cache['/repo/docs']).toMatchObject({
      loading: false,
      children: [{ name: 'guide.md' }]
    })
  })
})

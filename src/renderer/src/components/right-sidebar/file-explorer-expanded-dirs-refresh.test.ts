import { describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { DirEntry } from '../../../../shared/types'
import type { DirCache } from './file-explorer-types'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import { refreshFileExplorerExpandedDirs } from './file-explorer-expanded-dirs-refresh'

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
      readDirectory,
      // A limit at or above the dir count keeps one result batch.
      maxConcurrentReads: 16
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
      readDirectory,
      maxConcurrentReads: 16
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
      readDirectory,
      maxConcurrentReads: 16
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

  it('never exceeds maxConcurrentReads in flight and still commits every directory', async () => {
    const dirs = Array.from({ length: 20 }, (_, index) => ({
      dirPath: `/repo/d${index}`,
      depth: 0
    }))
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    let inFlight = 0
    let peakInFlight = 0
    const readDirectory = vi.fn(async (dirPath: string) => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight--
      return {
        entries: [entry(`${dirPath.slice('/repo/'.length)}.ts`)],
        operationOwner: { kind: 'local' as const }
      }
    })

    const refreshed = await refreshFileExplorerExpandedDirs({
      dirs,
      worktreePath: '/repo',
      dirLoadTracker: createFileExplorerDirLoadTracker(),
      setDirCache,
      readDirectory,
      maxConcurrentReads: 4
    })

    expect(refreshed).toBe(true)
    expect(peakInFlight).toBeLessThanOrEqual(4)
    expect(readDirectory).toHaveBeenCalledTimes(20)
    // One up-front loading write plus one result write per completed group of four.
    expect(setDirCache).toHaveBeenCalledTimes(6)
    for (const { dirPath } of dirs) {
      expect(cache[dirPath]).toMatchObject({
        loading: false,
        children: [{ name: expect.any(String) }]
      })
    }
  })

  it('marks queued dirs loading up front while the initial reads are blocked', async () => {
    const dirs = Array.from({ length: 9 }, (_, index) => ({
      dirPath: `/repo/d${index}`,
      depth: 0
    }))
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    let releaseInitialReads!: () => void
    const initialReadsGate = new Promise<void>((resolve) => {
      releaseInitialReads = resolve
    })
    const readDirectory = vi.fn(async (dirPath: string) => {
      if (['/repo/d0', '/repo/d1', '/repo/d2'].includes(dirPath)) {
        await initialReadsGate
      }
      return { entries: [], operationOwner: { kind: 'local' as const } }
    })

    const refreshPromise = refreshFileExplorerExpandedDirs({
      dirs,
      worktreePath: '/repo',
      dirLoadTracker: createFileExplorerDirLoadTracker(),
      setDirCache,
      readDirectory,
      maxConcurrentReads: 3
    })
    await Promise.resolve()

    expect(cache['/repo/d0']).toMatchObject({ loading: true })
    // A queued dir must already advertise loading:true, or FileExplorer's
    // auto-load effect fans out an unbounded loadDir for it on the next
    // `expanded` change — the reads this cap exists to bound.
    expect(cache['/repo/d6']).toMatchObject({ loading: true })
    expect(readDirectory).toHaveBeenCalledTimes(3)

    releaseInitialReads()
    await refreshPromise

    expect(cache['/repo/d6']).toMatchObject({ loading: false })
  })

  it('starts later reads as slots free without waiting for the slowest initial read', async () => {
    const dirs = Array.from({ length: 5 }, (_, index) => ({
      dirPath: `/repo/d${index}`,
      depth: 0
    }))
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    let releaseSlowRead!: () => void
    const slowRead = new Promise<void>((resolve) => {
      releaseSlowRead = resolve
    })
    const readDirectory = vi.fn(async (dirPath: string) => {
      if (dirPath === '/repo/d0') {
        await slowRead
      }
      return { entries: [entry('x.ts')], operationOwner: { kind: 'local' as const } }
    })

    const refreshPromise = refreshFileExplorerExpandedDirs({
      dirs,
      worktreePath: '/repo',
      dirLoadTracker: createFileExplorerDirLoadTracker(),
      setDirCache,
      readDirectory,
      maxConcurrentReads: 2
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(readDirectory.mock.calls.map(([dirPath]) => dirPath)).toEqual([
      '/repo/d0',
      '/repo/d1',
      '/repo/d2',
      '/repo/d3',
      '/repo/d4'
    ])
    expect(cache['/repo/d1']).toMatchObject({ loading: false })
    expect(cache['/repo/d0']).toMatchObject({ loading: true })

    releaseSlowRead()
    await expect(refreshPromise).resolves.toBe(true)
    expect(cache['/repo/d0']).toMatchObject({ loading: false })
  })

  it('does not turn a commit callback failure into an empty directory result', async () => {
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const commitError = new Error('commit failed')

    await expect(
      refreshFileExplorerExpandedDirs({
        dirs: [{ dirPath: '/repo/src', depth: 0 }],
        worktreePath: '/repo',
        dirLoadTracker: createFileExplorerDirLoadTracker(),
        setDirCache,
        readDirectory: async () => ({
          entries: [entry('index.ts')],
          operationOwner: { kind: 'local' as const }
        }),
        maxConcurrentReads: 1,
        onDirCommitted: () => {
          throw commitError
        }
      })
    ).rejects.toBe(commitError)

    expect(setDirCache).toHaveBeenCalledTimes(2)
    expect(cache['/repo/src']).toMatchObject({
      loading: false,
      children: [{ name: 'index.ts' }]
    })
  })

  it('still notifies the rest of a commit batch after one commit callback throws', async () => {
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const commitError = new Error('commit failed')
    const onDirCommitted = vi.fn((dirPath: string) => {
      if (dirPath === '/repo/a') {
        throw commitError
      }
    })

    await expect(
      refreshFileExplorerExpandedDirs({
        dirs: [
          { dirPath: '/repo/a', depth: 0 },
          { dirPath: '/repo/b', depth: 0 }
        ],
        worktreePath: '/repo',
        dirLoadTracker: createFileExplorerDirLoadTracker(),
        setDirCache,
        readDirectory: async () => ({
          entries: [entry('index.ts')],
          operationOwner: { kind: 'local' as const }
        }),
        // Both dirs land in one commit batch, so the throw must not strand the other's mark.
        maxConcurrentReads: 2,
        onDirCommitted
      })
    ).rejects.toBe(commitError)

    expect(onDirCommitted.mock.calls.map(([dirPath]) => dirPath).sort()).toEqual([
      '/repo/a',
      '/repo/b'
    ])
    expect(cache['/repo/b']).toMatchObject({ loading: false, children: [{ name: 'index.ts' }] })
  })

  it('stops later batches after a commit callback throws', async () => {
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const commitError = new Error('commit failed')
    const onDirCommitted = vi.fn((dirPath: string) => {
      if (dirPath === '/repo/a') {
        throw commitError
      }
    })

    await expect(
      refreshFileExplorerExpandedDirs({
        dirs: ['a', 'b', 'c', 'd'].map((name) => ({ dirPath: `/repo/${name}`, depth: 0 })),
        worktreePath: '/repo',
        dirLoadTracker: createFileExplorerDirLoadTracker(),
        setDirCache,
        readDirectory: async () => ({
          entries: [entry('index.ts')],
          operationOwner: { kind: 'local' as const }
        }),
        // Two dirs per commit batch, so /repo/c and /repo/d belong to a later batch.
        maxConcurrentReads: 2,
        onDirCommitted
      })
    ).rejects.toBe(commitError)

    // A surviving worker must not commit past the failure: callers observing the rejection
    // would otherwise still get setDirCache writes and staleness clears afterwards.
    expect(onDirCommitted.mock.calls.map(([dirPath]) => dirPath).sort()).toEqual([
      '/repo/a',
      '/repo/b'
    ])
    // One up-front loading write plus the single failed batch's result write.
    expect(setDirCache).toHaveBeenCalledTimes(2)
    expect(cache['/repo/c']).toMatchObject({ loading: true })
    expect(cache['/repo/d']).toMatchObject({ loading: true })
  })

  it('drops a queued directory superseded while an earlier read is blocked', async () => {
    const tracker = createFileExplorerDirLoadTracker()
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const readDirectory = vi.fn(async (dirPath: string) => {
      if (dirPath === '/repo/a') {
        await firstGate
      }
      return { entries: [entry('x.ts')], operationOwner: { kind: 'local' as const } }
    })

    const refreshPromise = refreshFileExplorerExpandedDirs({
      dirs: [
        { dirPath: '/repo/a', depth: 0 },
        { dirPath: '/repo/b', depth: 0 }
      ],
      worktreePath: '/repo',
      dirLoadTracker: tracker,
      setDirCache,
      readDirectory,
      maxConcurrentReads: 1
    })
    await Promise.resolve()

    // A watcher-driven refreshDir supersedes the queued dir before it starts reading.
    tracker.begin('/repo/b')
    const newerBCache: DirCache = { loading: false, children: [] }
    setDirCache((prev) => ({ ...prev, '/repo/b': newerBCache }))

    releaseFirst()
    const refreshed = await refreshPromise

    expect(refreshed).toBe(false)
    expect(cache['/repo/a']).toMatchObject({ loading: false, children: [{ name: 'x.ts' }] })
    // The queued task must neither read nor commit the superseded dir.
    expect(readDirectory).toHaveBeenCalledTimes(1)
    expect(cache['/repo/b']).toEqual(newerBCache)
  })
})

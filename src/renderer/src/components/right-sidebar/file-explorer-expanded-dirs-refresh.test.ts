import { describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import type { DirCache } from './file-explorer-types'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import { refreshFileExplorerExpandedDirs } from './file-explorer-expanded-dirs-refresh'
import type { FileExplorerLoadingDirsUpdater } from './file-explorer-dir-load-state'

type CacheUpdate = SetStateAction<Record<string, DirCache>>

function createLoadingDirPathsRecorder(): {
  updateLoadingDirPaths: FileExplorerLoadingDirsUpdater
  isLoading: (dirPath: string) => boolean
} {
  let loadingDirPaths: ReadonlySet<string> = new Set<string>()
  return {
    updateLoadingDirPaths: (update) => {
      loadingDirPaths = update(loadingDirPaths)
    },
    isLoading: (dirPath: string) => loadingDirPaths.has(dirPath)
  }
}

function entry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory, isSymlink: false }
}

describe('refreshFileExplorerExpandedDirs', () => {
  it('rebuilds the dirCache identity once per refresh of already-cached dirs', async () => {
    let cache: Record<string, DirCache> = {
      '/repo': {
        children: [
          { name: 'old', path: '/repo/old', relativePath: 'old', isDirectory: false, depth: 0 }
        ]
      },
      '/repo/src': { children: [] },
      '/repo/docs': { children: [] }
    }
    // Count committed identities: React skips equal state, while each new cache rebuilds the row projection.
    const committedCaches: Record<string, DirCache>[] = []
    const setDirCache = vi.fn((update: CacheUpdate) => {
      const next = typeof update === 'function' ? update(cache) : update
      if (next !== cache) {
        committedCaches.push(next)
      }
      cache = next
    })
    const { updateLoadingDirPaths, isLoading } = createLoadingDirPathsRecorder()
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
      updateLoadingDirPaths,
      readDirectory,
      // A limit at or above the dir count keeps one result batch.
      maxConcurrentReads: 16
    })

    expect(refreshed).toBe(true)
    expect(committedCaches).toHaveLength(1)
    expect(isLoading('/repo/src')).toBe(false)
    expect(isLoading('/repo/docs')).toBe(false)
    expect(committedCaches[0]).toMatchObject({
      '/repo': { children: [{ name: 'old' }] },
      '/repo/src': {
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
      '/repo/src': { children: [] },
      '/repo/docs': { children: [] }
    }
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const { updateLoadingDirPaths } = createLoadingDirPathsRecorder()
    const newerSrcCache: DirCache = {
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
        // A concurrent watcher load supersedes this in-flight read by advancing its token and committing newer children.
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
      updateLoadingDirPaths,
      readDirectory,
      maxConcurrentReads: 16
    })

    expect(refreshed).toBe(false)
    // Drop the superseded read instead of overwriting newer load state in the batched commit.
    expect(cache['/repo/src']).toEqual(newerSrcCache)
    expect(cache['/repo/docs']).toMatchObject({ children: [{ name: 'guide.md' }] })
  })

  it('drops a result superseded after its read resolved but before the batch commit', async () => {
    const tracker = createFileExplorerDirLoadTracker()
    let cache: Record<string, DirCache> = {
      '/repo/src': { children: [] },
      '/repo/docs': { children: [] }
    }
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const { updateLoadingDirPaths } = createLoadingDirPathsRecorder()
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
      updateLoadingDirPaths,
      readDirectory,
      maxConcurrentReads: 16
    })

    // Let src pass resolve-time checks while docs still blocks the batched commit.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Supersede src between its resolve-time check and final batched commit.
    tracker.begin('/repo/src')
    const newerSrcCache: DirCache = {
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
    expect(cache['/repo/src']).toEqual(newerSrcCache)
    expect(cache['/repo/docs']).toMatchObject({ children: [{ name: 'guide.md' }] })
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
    const { updateLoadingDirPaths, isLoading } = createLoadingDirPathsRecorder()
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
      updateLoadingDirPaths,
      readDirectory,
      maxConcurrentReads: 4
    })

    expect(refreshed).toBe(true)
    expect(peakInFlight).toBeLessThanOrEqual(4)
    expect(readDirectory).toHaveBeenCalledTimes(20)
    // One up-front loading write plus one result write per completed group of four.
    expect(setDirCache).toHaveBeenCalledTimes(6)
    for (const { dirPath } of dirs) {
      expect(cache[dirPath]).toMatchObject({ children: [{ name: expect.any(String) }] })
      expect(isLoading(dirPath)).toBe(false)
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
    const { updateLoadingDirPaths, isLoading } = createLoadingDirPathsRecorder()
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
      updateLoadingDirPaths,
      readDirectory,
      maxConcurrentReads: 3
    })
    await Promise.resolve()

    expect(isLoading('/repo/d0')).toBe(true)
    // Mark queued dirs loading up front or expansion effects can bypass the concurrency cap with duplicate reads.
    expect(isLoading('/repo/d6')).toBe(true)
    expect(readDirectory).toHaveBeenCalledTimes(3)

    releaseInitialReads()
    await refreshPromise

    expect(isLoading('/repo/d6')).toBe(false)
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
    const { updateLoadingDirPaths, isLoading } = createLoadingDirPathsRecorder()
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
      updateLoadingDirPaths,
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
    expect(isLoading('/repo/d1')).toBe(false)
    expect(isLoading('/repo/d0')).toBe(true)

    releaseSlowRead()
    await expect(refreshPromise).resolves.toBe(true)
    expect(isLoading('/repo/d0')).toBe(false)
  })

  it('does not turn a commit callback failure into an empty directory result', async () => {
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const { updateLoadingDirPaths } = createLoadingDirPathsRecorder()
    const commitError = new Error('commit failed')

    await expect(
      refreshFileExplorerExpandedDirs({
        dirs: [{ dirPath: '/repo/src', depth: 0 }],
        worktreePath: '/repo',
        dirLoadTracker: createFileExplorerDirLoadTracker(),
        setDirCache,
        updateLoadingDirPaths,
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
    expect(cache['/repo/src']).toMatchObject({ children: [{ name: 'index.ts' }] })
  })

  it('still notifies the rest of a commit batch after one commit callback throws', async () => {
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const { updateLoadingDirPaths } = createLoadingDirPathsRecorder()
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
        updateLoadingDirPaths,
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
    expect(cache['/repo/b']).toMatchObject({ children: [{ name: 'index.ts' }] })
  })

  it('stops later batches after a commit callback throws', async () => {
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const { updateLoadingDirPaths, isLoading } = createLoadingDirPathsRecorder()
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
        updateLoadingDirPaths,
        readDirectory: async () => ({
          entries: [entry('index.ts')],
          operationOwner: { kind: 'local' as const }
        }),
        // Two dirs per commit batch, so /repo/c and /repo/d belong to a later batch.
        maxConcurrentReads: 2,
        onDirCommitted
      })
    ).rejects.toBe(commitError)

    // Surviving workers must stop after rejection rather than commit later data/staleness writes.
    expect(onDirCommitted.mock.calls.map(([dirPath]) => dirPath).sort()).toEqual([
      '/repo/a',
      '/repo/b'
    ])
    // One up-front placeholder write plus the single failed batch's result write.
    expect(setDirCache).toHaveBeenCalledTimes(2)
    // Unstarted reads cannot clear spinners later; clear their loading marks now.
    expect(isLoading('/repo/c')).toBe(false)
    expect(isLoading('/repo/d')).toBe(false)
  })

  it('drops a queued directory superseded while an earlier read is blocked', async () => {
    const tracker = createFileExplorerDirLoadTracker()
    let cache: Record<string, DirCache> = {}
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const { updateLoadingDirPaths } = createLoadingDirPathsRecorder()
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
      updateLoadingDirPaths,
      readDirectory,
      maxConcurrentReads: 1
    })
    await Promise.resolve()

    // A watcher-driven refreshDir supersedes the queued dir before it starts reading.
    tracker.begin('/repo/b')
    const newerBCache: DirCache = { children: [] }
    setDirCache((prev) => ({ ...prev, '/repo/b': newerBCache }))

    releaseFirst()
    const refreshed = await refreshPromise

    expect(refreshed).toBe(false)
    expect(cache['/repo/a']).toMatchObject({ children: [{ name: 'x.ts' }] })
    expect(readDirectory).toHaveBeenCalledTimes(1)
    expect(cache['/repo/b']).toEqual(newerBCache)
  })

  it('keeps an opened folder link folder-shaped when a refresh re-reads its parent (#29069)', async () => {
    let cache: Record<string, DirCache> = {
      '/repo/src': {
        children: [
          {
            name: 'linked',
            path: '/repo/src/linked',
            relativePath: 'src/linked',
            isDirectory: true,
            isSymlink: true,
            depth: 1,
            operationOwner: { kind: 'local' }
          }
        ],
        operationOwner: { kind: 'local' }
      },
      '/repo/src/linked': { children: [], operationOwner: { kind: 'local' } }
    }
    const setDirCache = vi.fn((update: CacheUpdate) => {
      cache = typeof update === 'function' ? update(cache) : update
    })
    const { updateLoadingDirPaths } = createLoadingDirPathsRecorder()

    await refreshFileExplorerExpandedDirs({
      dirs: [{ dirPath: '/repo/src', depth: 0 }],
      worktreePath: '/repo',
      dirLoadTracker: createFileExplorerDirLoadTracker(),
      setDirCache,
      updateLoadingDirPaths,
      readDirectory: async () => ({
        // Without followSymlinks the host reports the link as a file.
        entries: [{ name: 'linked', isDirectory: false, isSymlink: true }],
        operationOwner: { kind: 'local' as const }
      }),
      maxConcurrentReads: 4
    })

    expect(cache['/repo/src'].children).toMatchObject([
      { name: 'linked', isDirectory: true, isSymlink: true }
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { DirEntry } from '../../../../../../shared/filesystem-entry-types'
import type { DirCache } from '../tree/file-explorer-types'
import { createFileExplorerDirLoadTracker } from '../tree/file-explorer-dir-load-tracker'
import { refreshFileExplorerExpandedDirs } from './file-explorer-expanded-dirs-refresh'
import type { FileExplorerLoadingDirsUpdater } from '../tree/file-explorer-dir-load-state'

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
})

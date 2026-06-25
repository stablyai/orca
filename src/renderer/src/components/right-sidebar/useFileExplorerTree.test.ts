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
      return entriesByPath[dirPath] ?? []
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
})

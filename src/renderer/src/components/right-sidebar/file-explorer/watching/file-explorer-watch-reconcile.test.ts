import { describe, expect, it, vi } from 'vitest'
import type { DirCache, TreeNode } from '../tree/file-explorer-types'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'
import { purgeDirCacheSubtrees } from './file-explorer-watcher-reconcile'

function cacheWithChildren(paths: string[]): DirCache {
  return {
    children: paths.map((path): TreeNode => ({
      name: path.split(/[\\/]/).at(-1) ?? path,
      path,
      relativePath: path,
      isDirectory: false,
      depth: 0,
      operationOwner: { kind: 'local' }
    })),
    operationOwner: { kind: 'local' }
  }
}

describe('processFileExplorerFsPayload update reconciliation', () => {
  it('purges Windows descendants case-insensitively without folding remote POSIX paths', () => {
    let cache: Record<string, DirCache> = {
      'C:\\Repo\\Old': cacheWithChildren([]),
      'c:\\repo\\OLD\\child': cacheWithChildren([]),
      'C:\\Repo\\Keep': cacheWithChildren([]),
      '/srv/repo/Old': cacheWithChildren([]),
      '/srv/repo/Old/child': cacheWithChildren([]),
      '/srv/repo/old/keep': cacheWithChildren([])
    }
    type DirCacheUpdate = Parameters<Parameters<typeof purgeDirCacheSubtrees>[0]>[0]
    const setDirCache = (update: DirCacheUpdate): void => {
      cache = update(cache).dirCache
    }

    purgeDirCacheSubtrees(setDirCache, new Set(['C:\\repo\\old', '/srv/repo/Old']))

    expect(Object.keys(cache)).toEqual(['C:\\Repo\\Keep', '/srv/repo/old/keep'])
  })

  it('purges every Windows cache key even when the normalized path index collapses aliases', () => {
    const root = 'C:\\Repo'
    let cache: Record<string, DirCache> = {
      [root]: cacheWithChildren([]),
      'C:\\Repo\\Old': cacheWithChildren([]),
      'c:\\repo\\OLD': cacheWithChildren([]),
      'C:\\Repo\\New': cacheWithChildren([]),
      'c:\\repo\\NEW': cacheWithChildren([]),
      'C:\\Repo\\Keep': cacheWithChildren([])
    }
    type DirCacheUpdate = Parameters<Parameters<typeof purgeDirCacheSubtrees>[0]>[0]
    processFileExplorerFsPayload({
      payload: {
        worktreePath: root,
        events: [
          {
            kind: 'rename',
            oldAbsolutePath: 'c:\\repo\\old',
            absolutePath: 'c:\\repo\\new',
            isDirectory: true
          }
        ]
      },
      currentWorktreePath: root,
      worktreeId: 'wt-1',
      cache,
      expanded: new Set(),
      setDirCache: (update: DirCacheUpdate) => {
        cache = update(cache).dirCache
      },
      setSelectedPath: vi.fn(),
      refreshDir: vi.fn(),
      refreshTree: vi.fn()
    })
    expect(Object.keys(cache)).toEqual([root, 'C:\\Repo\\Keep'])
  })

  it('uses the newer cache when the functional purge runs after another update', () => {
    const root = '/repo'
    const cache: Record<string, DirCache> = {
      [root]: cacheWithChildren([]),
      '/repo/old': cacheWithChildren([]),
      '/repo/new': cacheWithChildren([])
    }
    type DirCacheUpdate = Parameters<Parameters<typeof purgeDirCacheSubtrees>[0]>[0]
    let pending: DirCacheUpdate | undefined
    processFileExplorerFsPayload({
      payload: {
        worktreePath: root,
        events: [
          {
            kind: 'rename',
            oldAbsolutePath: '/repo/old',
            absolutePath: '/repo/new',
            isDirectory: true
          }
        ]
      },
      currentWorktreePath: root,
      worktreeId: 'wt-1',
      cache,
      expanded: new Set(),
      setDirCache: (update) => {
        pending = update
      },
      setSelectedPath: vi.fn(),
      refreshDir: vi.fn(),
      refreshTree: vi.fn()
    })
    expect(typeof pending).toBe('function')
    const newer = {
      ...cache,
      '/repo/added': cacheWithChildren([]),
      '/repo/old/added-child': cacheWithChildren([])
    }
    if (typeof pending !== 'function') {
      throw new Error('Expected a queued functional cache purge')
    }
    const result = pending(newer).dirCache
    expect(Object.keys(result)).toEqual([root, '/repo/added'])
    expect(result['/repo/added']).toBe(newer['/repo/added'])
  })
})

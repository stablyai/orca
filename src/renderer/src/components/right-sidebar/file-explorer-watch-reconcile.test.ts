import { describe, expect, it, vi } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'
import { purgeDirCacheSubtrees } from './file-explorer-watcher-reconcile'
import { useAppStore } from '@/store'

function cacheWithChildren(paths: string[]): DirCache {
  return {
    children: paths.map(
      (path): TreeNode => ({
        name: path.split(/[\\/]/).at(-1) ?? path,
        path,
        relativePath: path,
        isDirectory: false,
        depth: 0,
        operationOwner: { kind: 'local' }
      })
    ),
    loading: false,
    operationOwner: { kind: 'local' }
  }
}

function cacheWithMeasuredChildren(paths: string[], onPathRead: () => void): DirCache {
  const cache = cacheWithChildren(paths)
  for (let index = 0; index < paths.length; index++) {
    Object.defineProperty(cache.children[index]!, 'path', {
      get: () => {
        onPathRead()
        return paths[index]
      }
    })
  }
  return cache
}

function processUpdate(args: {
  root: string
  absolutePath: string
  isDirectory?: boolean
  cache: Record<string, DirCache>
}): ReturnType<typeof vi.fn> {
  const refreshDir = vi.fn()
  processFileExplorerFsPayload({
    payload: {
      worktreePath: args.root,
      events: [{ kind: 'update', absolutePath: args.absolutePath, isDirectory: args.isDirectory }]
    },
    currentWorktreePath: args.root,
    worktreeId: 'wt-1',
    cache: args.cache,
    expanded: new Set(),
    setDirCache: vi.fn(),
    setSelectedPath: vi.fn(),
    refreshDir,
    refreshTree: vi.fn()
  })
  return refreshDir
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
      cache = typeof update === 'function' ? update(cache) : update
    }

    purgeDirCacheSubtrees(setDirCache, new Set(['C:\\repo\\old', '/srv/repo/Old']))

    expect(Object.keys(cache)).toEqual(['C:\\Repo\\Keep', '/srv/repo/old/keep'])
  })

  it('refreshes a cached parent when Windows reports a new file as update', () => {
    const root = 'C:\\Repo'
    const refreshDir = processUpdate({
      root,
      absolutePath: 'c:\\repo\\new-file.txt',
      isDirectory: false,
      cache: { [root]: cacheWithChildren([`${root}\\existing.txt`]) }
    })

    expect(refreshDir).toHaveBeenCalledOnce()
    expect(refreshDir).toHaveBeenCalledWith(root)
  })

  it('does not reread a directory for an existing file content update', () => {
    const root = 'C:\\Repo'
    const refreshDir = processUpdate({
      root,
      absolutePath: 'c:\\repo\\EXISTING.txt',
      isDirectory: false,
      cache: { [root]: cacheWithChildren([`${root}\\existing.txt`]) }
    })

    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('indexes cached children once for a large update batch', () => {
    const root = 'C:\\Repo'
    const paths = Array.from({ length: 1_000 }, (_, index) => `${root}\\file-${index}.txt`)
    let pathReads = 0
    const refreshDir = vi.fn()

    processFileExplorerFsPayload({
      payload: {
        worktreePath: root,
        events: paths.map((absolutePath) => ({
          kind: 'update' as const,
          absolutePath: absolutePath.toLowerCase(),
          isDirectory: false
        }))
      },
      currentWorktreePath: root,
      worktreeId: 'wt-1',
      cache: { [root]: cacheWithMeasuredChildren(paths, () => pathReads++) },
      expanded: new Set(),
      setDirCache: vi.fn(),
      setSelectedPath: vi.fn(),
      refreshDir,
      refreshTree: vi.fn()
    })

    expect(pathReads).toBe(paths.length)
    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('indexes cached directory keys once for a maximum update batch', () => {
    const root = 'C:\\Repo'
    const entries: Record<string, DirCache> = {
      [root]: cacheWithChildren([])
    }
    for (let index = 0; index < 2_000; index++) {
      entries[`${root}\\dir-${index}`] = cacheWithChildren([])
    }
    let cacheKeyReads = 0
    const cache = new Proxy(entries, {
      ownKeys(target) {
        cacheKeyReads++
        return Reflect.ownKeys(target)
      }
    })
    const refreshDir = vi.fn()

    processFileExplorerFsPayload({
      payload: {
        worktreePath: root,
        events: Array.from({ length: 5_000 }, (_, index) => ({
          kind: 'update' as const,
          absolutePath: `c:\\repo\\new-${index}.txt`,
          isDirectory: false
        }))
      },
      currentWorktreePath: root,
      worktreeId: 'wt-1',
      cache,
      expanded: new Set(),
      setDirCache: vi.fn(),
      setSelectedPath: vi.fn(),
      refreshDir,
      refreshTree: vi.fn()
    })

    expect(cacheKeyReads).toBe(1)
    expect(refreshDir).toHaveBeenCalledOnce()
    expect(refreshDir).toHaveBeenCalledWith(root)
  })

  it('does not rescan expanded directories for each refreshed cached parent', () => {
    const root = 'C:\\Repo'
    const cache: Record<string, DirCache> = { [root]: cacheWithChildren([]) }
    const expandedPaths: string[] = []
    for (let index = 0; index < 2_000; index++) {
      cache[`${root}\\dir-${index}`] = cacheWithChildren([])
      expandedPaths.push(`c:\\repo\\DIR-${index}`)
    }
    let expandedPathReads = 0
    const expanded = new Set(expandedPaths)
    const expandedIterator = expanded[Symbol.iterator].bind(expanded)
    expanded[Symbol.iterator] = function* measuredExpandedIterator() {
      for (const path of expandedIterator()) {
        expandedPathReads++
        yield path
      }
      return undefined
    }
    const refreshDir = vi.fn()

    processFileExplorerFsPayload({
      payload: {
        worktreePath: root,
        events: Array.from({ length: 5_000 }, (_, index) => ({
          kind: 'create' as const,
          absolutePath: `c:\\repo\\dir-${index % 2_000}\\new-${index}.txt`,
          isDirectory: false
        }))
      },
      currentWorktreePath: root,
      worktreeId: 'wt-1',
      cache,
      expanded,
      setDirCache: vi.fn(),
      setSelectedPath: vi.fn(),
      refreshDir,
      refreshTree: vi.fn()
    })

    expect(expandedPathReads).toBe(0)
    expect(refreshDir).toHaveBeenCalledTimes(2_000)
    expect(new Set(refreshDir.mock.calls.map(([dirPath]) => dirPath)).size).toBe(2_000)
  })

  it('keeps POSIX child matching case-sensitive', () => {
    const root = '/repo'
    const refreshDir = processUpdate({
      root,
      absolutePath: '/repo/EXISTING.txt',
      isDirectory: false,
      cache: { [root]: cacheWithChildren(['/repo/existing.txt']) }
    })

    expect(refreshDir).toHaveBeenCalledWith(root)
  })

  it('refreshes an existing directory when the update identifies it as a directory', () => {
    const root = '/repo'
    const child = '/repo/src'
    const refreshDir = processUpdate({
      root,
      absolutePath: child,
      isDirectory: true,
      cache: { [root]: cacheWithChildren([child]), [child]: cacheWithChildren([]) }
    })

    expect(refreshDir).toHaveBeenCalledOnce()
    expect(refreshDir).toHaveBeenCalledWith(child)
  })

  it('deduplicates repeated remote update events for an absent child', () => {
    const root = '/srv/workspace'
    const refreshDir = vi.fn()
    processFileExplorerFsPayload({
      payload: {
        worktreePath: root,
        events: [
          { kind: 'update', absolutePath: `${root}/new.txt`, isDirectory: false },
          { kind: 'update', absolutePath: `${root}/new.txt`, isDirectory: false }
        ]
      },
      currentWorktreePath: root,
      worktreeId: 'folder::remote-1',
      cache: { [root]: cacheWithChildren([]) },
      expanded: new Set(),
      setDirCache: vi.fn(),
      setSelectedPath: vi.fn(),
      refreshDir,
      refreshTree: vi.fn()
    })

    expect(refreshDir).toHaveBeenCalledOnce()
    expect(refreshDir).toHaveBeenCalledWith(root)
  })

  it('ignores an update payload from another workspace', () => {
    const root = '/srv/workspace'
    const refreshDir = vi.fn()
    processFileExplorerFsPayload({
      payload: {
        worktreePath: '/srv/other',
        events: [{ kind: 'update', absolutePath: '/srv/other/new.txt', isDirectory: false }]
      },
      currentWorktreePath: root,
      worktreeId: 'folder::remote-1',
      cache: { [root]: cacheWithChildren([]) },
      expanded: new Set(),
      setDirCache: vi.fn(),
      setSelectedPath: vi.fn(),
      refreshDir,
      refreshTree: vi.fn()
    })

    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('refreshes both parents for a synthetic cross-directory rename', () => {
    const root = '/repo'
    const sourceDir = `${root}/source`
    const targetDir = `${root}/target`
    const refreshDir = vi.fn()
    const refreshTree = vi.fn()
    const setSelectedPath = vi.fn()

    processFileExplorerFsPayload({
      payload: {
        worktreePath: root,
        events: [
          {
            kind: 'rename',
            oldAbsolutePath: `${sourceDir}/old.txt`,
            absolutePath: `${targetDir}/new.txt`,
            isDirectory: false
          }
        ]
      },
      currentWorktreePath: root,
      worktreeId: 'folder::remote-1',
      cache: {
        [root]: cacheWithChildren([sourceDir, targetDir]),
        [sourceDir]: cacheWithChildren([`${sourceDir}/old.txt`]),
        [targetDir]: cacheWithChildren([])
      },
      expanded: new Set([sourceDir, targetDir]),
      setDirCache: vi.fn(),
      setSelectedPath,
      refreshDir,
      refreshTree
    })

    expect(refreshDir).toHaveBeenCalledTimes(2)
    expect(refreshDir).toHaveBeenCalledWith(sourceDir)
    expect(refreshDir).toHaveBeenCalledWith(targetDir)
    expect(refreshTree).not.toHaveBeenCalled()
    expect(setSelectedPath.mock.calls[0]?.[0](`${sourceDir}/old.txt`)).toBeNull()
  })

  it('deduplicates subtree and selection state work for repeated renames', () => {
    const root = '/repo'
    const sourceDir = `${root}/source`
    const targetDir = `${root}/target`
    const oldDir = `${sourceDir}/old`
    const newDir = `${targetDir}/new`
    const rename = {
      kind: 'rename' as const,
      oldAbsolutePath: oldDir,
      absolutePath: newDir,
      isDirectory: true
    }
    const setDirCache = vi.fn()
    const setSelectedPath = vi.fn()
    const refreshDir = vi.fn()

    processFileExplorerFsPayload({
      payload: { worktreePath: root, events: [rename, rename] },
      currentWorktreePath: root,
      worktreeId: 'wt-1',
      cache: {
        [sourceDir]: cacheWithChildren([oldDir]),
        [targetDir]: cacheWithChildren([newDir]),
        [oldDir]: cacheWithChildren([]),
        [newDir]: cacheWithChildren([])
      },
      expanded: new Set([sourceDir, targetDir]),
      setDirCache,
      setSelectedPath,
      refreshDir,
      refreshTree: vi.fn()
    })

    expect(setDirCache).toHaveBeenCalledOnce()
    expect(setSelectedPath).toHaveBeenCalledOnce()
    expect(refreshDir).toHaveBeenCalledTimes(2)
  })

  it('purges distinct cached directory renames with one bounded cache scan', () => {
    const root = '/repo'
    const worktreeId = 'watch-reconcile-perf'
    const entries: Record<string, DirCache> = { [root]: cacheWithChildren([]) }
    const expandedPaths: string[] = []
    const events = Array.from({ length: 1_000 }, (_, index) => {
      entries[`${root}/old-${index}`] = cacheWithChildren([])
      entries[`${root}/new-${index}`] = cacheWithChildren([])
      expandedPaths.push(`${root}/old-${index}`, `${root}/new-${index}`)
      return {
        kind: 'rename' as const,
        oldAbsolutePath: `${root}/old-${index}`,
        absolutePath: `${root}/new-${index}`,
        isDirectory: true
      }
    })
    let keyVisits = 0
    const entryCount = Object.keys(entries).length
    const measured = (value: Record<string, DirCache>): Record<string, DirCache> =>
      new Proxy(value, {
        getOwnPropertyDescriptor(target, property) {
          keyVisits++
          return Reflect.getOwnPropertyDescriptor(target, property)
        }
      })
    let current = measured(entries)
    type DirCacheUpdate = Parameters<
      Parameters<typeof processFileExplorerFsPayload>[0]['setDirCache']
    >[0]
    const setDirCache = vi.fn((update: DirCacheUpdate) => {
      current = measured(typeof update === 'function' ? update(current) : update)
    })
    let expandedPathReads = 0
    const expanded = new Set(expandedPaths)
    const expandedIterator = expanded[Symbol.iterator].bind(expanded)
    expanded[Symbol.iterator] = function* measuredExpandedIterator() {
      for (const path of expandedIterator()) {
        expandedPathReads++
        yield path
      }
      return undefined
    }
    const previousExpandedDirs = useAppStore.getState().expandedDirs
    let remainingExpanded: Set<string> | undefined

    try {
      useAppStore.setState({
        expandedDirs: { ...previousExpandedDirs, [worktreeId]: expanded }
      })
      processFileExplorerFsPayload({
        payload: { worktreePath: root, events },
        currentWorktreePath: root,
        worktreeId,
        cache: current,
        expanded,
        setDirCache,
        setSelectedPath: vi.fn(),
        refreshDir: vi.fn(),
        refreshTree: vi.fn()
      })
      remainingExpanded = useAppStore.getState().expandedDirs[worktreeId]
    } finally {
      useAppStore.setState({ expandedDirs: previousExpandedDirs })
    }

    expect(setDirCache).toHaveBeenCalledOnce()
    expect(keyVisits).toBe(entryCount * 2)
    expect(expandedPathReads).toBe(expandedPaths.length)
    expect(remainingExpanded).toEqual(new Set())
  })
})

describe('processFileExplorerFsPayload overflow reconciliation', () => {
  it('routes an overflow event to a single tree refresh and skips per-dir refreshes', () => {
    const root = '/repo'
    const refreshDir = vi.fn()
    const refreshTree = vi.fn()
    processFileExplorerFsPayload({
      payload: {
        worktreePath: root,
        events: [
          { kind: 'create', absolutePath: `${root}/a.txt` },
          { kind: 'overflow', absolutePath: root },
          { kind: 'create', absolutePath: `${root}/src/b.txt` }
        ]
      },
      currentWorktreePath: root,
      worktreeId: 'wt-1',
      cache: { [root]: cacheWithChildren([]), [`${root}/src`]: cacheWithChildren([]) },
      expanded: new Set([`${root}/src`]),
      setDirCache: vi.fn(),
      setSelectedPath: vi.fn(),
      refreshDir,
      refreshTree
    })

    expect(refreshTree).toHaveBeenCalledOnce()
    expect(refreshDir).not.toHaveBeenCalled()
  })
})

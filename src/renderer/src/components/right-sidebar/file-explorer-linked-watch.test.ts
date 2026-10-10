import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import type { DirCache, TreeNode } from './file-explorer-types'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'
import { createFileExplorerWatchRefreshScheduler } from './file-explorer-watch-refresh-scheduler'
import { joinPath } from '@/lib/path'

function node(path: string, isDirectory = false, isSymlink = false): TreeNode {
  return { path, name: path, relativePath: path, depth: 0, isDirectory, isSymlink }
}

function fixture(root = '/repo') {
  const link = joinPath(root, 'link')
  let cache: Record<string, DirCache> = {
    [root]: { children: [node(link, true, true)] },
    [link]: { children: [node(joinPath(link, 'old.ts'))] }
  }
  let selected: string | null = joinPath(link, 'old.ts')
  const setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>> = (value) => {
    cache = typeof value === 'function' ? value(cache) : value
  }
  const setSelectedPath: Dispatch<SetStateAction<string | null>> = (value) => {
    selected = typeof value === 'function' ? value(selected) : value
  }
  const refreshTree = vi.fn()
  const refreshDir = vi.fn()
  const process = (events: FsChangeEvent[], followSymlinks = true, eventRoot = root) =>
    processFileExplorerFsPayload({
      payload: { worktreePath: eventRoot, events },
      currentWorktreePath: root,
      worktreeId: 'linked-watch',
      cache,
      expanded: new Set(),
      followSymlinks,
      setDirCache,
      setSelectedPath,
      refreshTree,
      refreshDir
    })
  return { root, link, cache, process, refreshTree, refreshDir, selected: () => selected }
}

afterEach(() => vi.useRealTimers())

describe('linked-directory watcher invalidation', () => {
  it.each(['/repo', 'C:\\Repo', '\\\\host\\share\\repo'])(
    'refreshes a collapsed cached alias even when canonical target is not cached (%s)',
    (root) => {
      const f = fixture(root)
      f.process([{ kind: 'create', absolutePath: joinPath(root, 'target/new.ts') }])
      expect(f.refreshTree).toHaveBeenCalledOnce()
      expect(f.refreshDir).not.toHaveBeenCalled()
      expect(f.cache[f.link].children).toHaveLength(1)
      expect(f.selected()).toBe(joinPath(f.link, 'old.ts'))
    }
  )

  it.each([
    { kind: 'update' as const, absolutePath: '/repo/target/new.ts', isDirectory: false },
    { kind: 'update' as const, absolutePath: '/repo/target', isDirectory: true },
    { kind: 'update' as const, absolutePath: '/repo/link', isDirectory: false },
    { kind: 'delete' as const, absolutePath: '/repo/target/deleted.ts' },
    {
      kind: 'rename' as const,
      absolutePath: '/repo/target/new.ts',
      oldAbsolutePath: '/repo/target/old.ts'
    }
  ])('refreshes structural uncertainty including link retarget: %j', (event) => {
    const f = fixture()
    f.process([event])
    expect(f.refreshTree).toHaveBeenCalledOnce()
  })

  it('keeps known regular content edits cheap and honors node directory/symlink flags', () => {
    const f = fixture('C:\\Repo')
    const target = 'C:\\Repo\\Target'
    f.cache[target] = { children: [node(`${target}\\file.ts`), node(`${target}\\dir`, true)] }
    f.process([{ kind: 'update', absolutePath: 'c:/repo/target/FILE.ts', isDirectory: false }])
    expect(f.refreshTree).not.toHaveBeenCalled()
    expect(f.refreshDir).not.toHaveBeenCalled()
    f.process([{ kind: 'update', absolutePath: 'c:/repo/target/DIR', isDirectory: false }])
    expect(f.refreshTree).toHaveBeenCalledOnce()
  })

  it('keeps cached historical aliases refreshed with the Quick Open preference disabled', () => {
    const f = fixture()
    const event = { kind: 'create' as const, absolutePath: '/repo/target/new.ts' }
    f.process([event], false)
    expect(f.refreshTree).toHaveBeenCalledOnce()
    f.refreshTree.mockClear()
    f.process([{ ...event, absolutePath: '/other/new.ts' }])
    f.process([event], true, '/other')
    expect(f.refreshTree).not.toHaveBeenCalled()
    delete f.cache[f.link]
    f.process([event])
    expect(f.refreshTree).not.toHaveBeenCalled()
  })

  it('still clears a lexical deleted selection after a prior event requested full refresh', () => {
    const f = fixture()
    f.process([
      { kind: 'create', absolutePath: '/repo/target/new.ts' },
      { kind: 'delete', absolutePath: '/repo/link/old.ts' }
    ])
    expect(f.refreshTree).toHaveBeenCalledOnce()
    expect(f.selected()).toBeNull()
  })

  it('coalesces structural bursts and retains a second refresh while the first is in flight', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let complete: () => void = () => undefined
    const firstRead = new Promise<void>((resolve) => {
      complete = resolve
    })
    const refreshTree = vi.fn(async () => {
      if (refreshTree.mock.calls.length === 1) {
        await firstRead
      }
      return 'refreshed' as const
    })
    const scheduler = createFileExplorerWatchRefreshScheduler({
      refreshTree,
      refreshDir: async () => undefined,
      isCoveredByFullRefresh: () => true,
      dirConcurrency: 4,
      trailingMs: 0,
      maxWaitMs: 0
    })
    f.refreshTree.mockImplementation(scheduler.requestFullRefresh)
    for (let i = 0; i < 100; i++) {
      f.process([{ kind: 'create', absolutePath: `/repo/target/${i}` }])
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshTree).toHaveBeenCalledOnce()
    f.process([{ kind: 'delete', absolutePath: '/repo/target/after-snapshot' }])
    complete()
    await vi.advanceTimersByTimeAsync(1)
    expect(refreshTree).toHaveBeenCalledTimes(2)
    scheduler.cancel()
  })
})

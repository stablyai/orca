import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import type { FsChangeEvent } from '../../../../../../shared/filesystem-entry-types'
import type { DirCache, TreeNode } from '../tree/file-explorer-types'
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
      dirConcurrency: 4
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

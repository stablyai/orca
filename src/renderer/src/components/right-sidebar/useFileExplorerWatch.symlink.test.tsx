// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type {
  DirCache,
  FileExplorerOperationOwner,
  FileExplorerTreeRefreshOutcome,
  TreeNode
} from './file-explorer-types'

const ownerRef = vi.hoisted(() => ({ current: { kind: 'local' } as FileExplorerOperationOwner }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({})
  })
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ownerRef.current,
  getFileExplorerOperationOwnerFromState: () => ownerRef.current
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  subscribeRuntimeFileChanges: vi.fn(async () => () => undefined)
}))

import { useFileExplorerWatch } from './useFileExplorerWatch'

type WatchHandler = (payload: FsChangedPayload) => void
type WatchArgs = { worktreePath: string; connectionId?: string }

function dirNode(name: string, isSymlink: boolean): TreeNode {
  return {
    name,
    path: `/repo/${name}`,
    relativePath: name,
    // Local listings report symlinks as file-shaped, even once one is expanded and re-listed.
    isDirectory: !isSymlink,
    isSymlink,
    depth: 0
  }
}

const dirCache: Record<string, DirCache> = {
  '/repo': { children: [dirNode('linked', true), dirNode('other', true), dirNode('src', false)] },
  '/repo/linked': { children: [] },
  '/repo/other': { children: [] },
  '/repo/src': { children: [] }
}

describe('useFileExplorerWatch symlinked directories (#24285)', () => {
  let mainWatchHandler: WatchHandler | null
  let watchWorktree: ReturnType<typeof vi.fn<(args: WatchArgs) => Promise<void>>>
  let unwatchWorktree: ReturnType<typeof vi.fn<(args: WatchArgs) => Promise<void>>>
  let refreshDir: ReturnType<typeof vi.fn<(dirPath: string) => Promise<void>>>
  let refreshTree: ReturnType<typeof vi.fn<() => Promise<FileExplorerTreeRefreshOutcome>>>

  beforeEach(() => {
    vi.useFakeTimers()
    ownerRef.current = { kind: 'local' }
    mainWatchHandler = null
    watchWorktree = vi.fn(async () => {})
    unwatchWorktree = vi.fn(async () => {})
    refreshDir = vi.fn(async () => {})
    refreshTree = vi.fn(async () => 'refreshed' as const)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fs: {
          watchWorktree,
          unwatchWorktree,
          onFsChanged: vi.fn((handler: WatchHandler) => {
            mainWatchHandler = handler
            return vi.fn()
          })
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function renderWatch(expanded: Set<string>) {
    return renderHook(
      ({ expandedDirs }: { expandedDirs: Set<string> }) =>
        useFileExplorerWatch({
          worktreePath: '/repo',
          activeWorktreeId: 'wt-1',
          dirCache,
          setDirCache: vi.fn(),
          expanded: expandedDirs,
          setSelectedPath: vi.fn(),
          refreshDir,
          refreshTree,
          inlineInput: null,
          dragSourcePath: null,
          isNativeDragOver: false,
          operationOwner: ownerRef.current
        }),
      { initialProps: { expandedDirs: expanded } }
    )
  }

  it('watches an expanded symlinked folder and refreshes it when a file appears inside', async () => {
    renderWatch(new Set(['/repo/linked']))

    expect(watchWorktree).toHaveBeenCalledWith({ worktreePath: '/repo/linked' })

    // Main resolves the link and maps target paths back under it, keyed by the link path.
    act(() =>
      mainWatchHandler!({
        worktreePath: '/repo/linked',
        events: [{ kind: 'create', absolutePath: '/repo/linked/new.txt', isDirectory: false }]
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))

    expect(refreshDir).toHaveBeenCalledWith('/repo/linked')
  })

  it('stops watching the symlinked folder on collapse and on unmount', () => {
    const hook = renderWatch(new Set(['/repo/linked']))
    hook.rerender({ expandedDirs: new Set() })
    expect(unwatchWorktree).toHaveBeenCalledWith({ worktreePath: '/repo/linked' })

    hook.rerender({ expandedDirs: new Set(['/repo/linked']) })
    expect(watchWorktree).toHaveBeenCalledTimes(2)
    hook.unmount()
    expect(unwatchWorktree).toHaveBeenCalledTimes(2)
  })

  it('watches each symlinked folder once while another one is expanded or collapsed', () => {
    const hook = renderWatch(new Set(['/repo/linked']))
    hook.rerender({ expandedDirs: new Set(['/repo/linked', '/repo/other']) })
    hook.rerender({ expandedDirs: new Set(['/repo/linked']) })

    expect(watchWorktree.mock.calls.map(([args]) => args.worktreePath)).toEqual([
      '/repo/linked',
      '/repo/other'
    ])
    expect(unwatchWorktree.mock.calls.map(([args]) => args.worktreePath)).toEqual(['/repo/other'])
  })

  it('adds no watch for regular folders, which the worktree watch already covers', () => {
    renderWatch(new Set(['/repo/src']))
    expect(watchWorktree).not.toHaveBeenCalled()
  })

  it('ignores events for a symlinked folder that is no longer expanded', async () => {
    const hook = renderWatch(new Set(['/repo/linked']))
    hook.rerender({ expandedDirs: new Set() })

    act(() =>
      mainWatchHandler!({
        worktreePath: '/repo/linked',
        events: [{ kind: 'create', absolutePath: '/repo/linked/new.txt', isDirectory: false }]
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))

    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('leaves SSH worktrees on their existing watch', () => {
    ownerRef.current = { kind: 'ssh', connectionId: 'ssh-1' }
    renderWatch(new Set(['/repo/linked']))
    expect(watchWorktree).not.toHaveBeenCalled()
  })
})

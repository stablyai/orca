// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type {
  FileExplorerOperationOwner,
  FileExplorerTreeRefreshOutcome
} from './file-explorer-types'

const ownerRef = vi.hoisted(() => ({ current: { kind: 'local' } as FileExplorerOperationOwner }))
const runtimeWatch = vi.hoisted(() => ({
  subscribe: vi.fn()
}))

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
  subscribeRuntimeFileChanges: runtimeWatch.subscribe
}))

import { useFileExplorerWatch } from './useFileExplorerWatch'

type WatchHandler = (payload: FsChangedPayload) => void

describe('useFileExplorerWatch pending refreshes', () => {
  let mainWatchHandler: WatchHandler | null
  let refreshDir: ReturnType<typeof vi.fn<(dirPath: string) => Promise<void>>>
  let refreshTree: ReturnType<typeof vi.fn<() => Promise<FileExplorerTreeRefreshOutcome>>>

  beforeEach(() => {
    vi.useFakeTimers()
    ownerRef.current = { kind: 'local' }
    mainWatchHandler = null
    runtimeWatch.subscribe.mockReset()
    refreshDir = vi.fn(async () => {})
    refreshTree = vi.fn(async () => 'refreshed' as const)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fs: {
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

  function renderWatch(
    worktreePath: string | null = '/repo',
    interaction: 'rename' | 'drag' | 'native' | null = null
  ) {
    const setDirCache = vi.fn()
    const setSelectedPath = vi.fn()
    return renderHook(
      ({
        visiblePath,
        activeInteraction
      }: {
        visiblePath: string | null
        activeInteraction: typeof interaction
      }) =>
        useFileExplorerWatch({
          worktreePath: visiblePath,
          activeWorktreeId: 'wt-1',
          dirCache: { '/repo': { children: [] } },
          setDirCache,
          expanded: new Set(),
          setSelectedPath,
          refreshDir,
          refreshTree,
          inlineInput:
            activeInteraction === 'rename'
              ? { parentPath: '/repo', type: 'rename', depth: 0 }
              : null,
          dragSourcePath: activeInteraction === 'drag' ? '/repo/example.ts' : null,
          isNativeDragOver: activeInteraction === 'native',
          operationOwner: ownerRef.current
        }),
      { initialProps: { visiblePath: worktreePath, activeInteraction: interaction } }
    )
  }

  function emit(handler: WatchHandler): void {
    handler({
      worktreePath: '/repo',
      events: [{ kind: 'create', absolutePath: '/repo/new.ts', isDirectory: false }]
    })
  }

  function emitRuntimeBatch(): void {
    emit((payload) =>
      window.dispatchEvent(
        new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
          detail: { payload, runtimeEnvironmentId: 'runtime-1' }
        })
      )
    )
  }

  it('resyncs on reopen when hiding Files cancelled a received remote event', async () => {
    ownerRef.current = { kind: 'ssh', connectionId: 'ssh-1' }
    const hook = renderWatch()
    expect(mainWatchHandler).not.toBeNull()

    act(() => emit(mainWatchHandler!))
    hook.rerender({ visiblePath: null, activeInteraction: null })
    hook.rerender({ visiblePath: '/repo', activeInteraction: null })
    await act(async () => vi.advanceTimersByTimeAsync(0))

    expect(refreshTree).toHaveBeenCalledOnce()
    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('flushes main SSH batches on the next turn without another debounce window', async () => {
    ownerRef.current = { kind: 'ssh', connectionId: 'ssh-1' }
    renderWatch()

    act(() => emit(mainWatchHandler!))
    expect(refreshDir).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(0))

    expect(refreshDir).toHaveBeenCalledOnce()
  })

  it('flushes remote broker batches on the next turn without another debounce window', async () => {
    ownerRef.current = {
      kind: 'runtime',
      environmentId: 'runtime-1',
      executionHostId: 'runtime:runtime-1'
    }
    renderWatch()
    expect(runtimeWatch.subscribe).not.toHaveBeenCalled()

    act(emitRuntimeBatch)
    expect(refreshDir).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(0))

    expect(refreshDir).toHaveBeenCalledOnce()
  })

  it('resyncs on reopen after hiding Files canceled a received broker event', async () => {
    ownerRef.current = {
      kind: 'runtime',
      environmentId: 'runtime-1',
      executionHostId: 'runtime:runtime-1'
    }
    const hook = renderWatch()
    act(emitRuntimeBatch)
    hook.rerender({ visiblePath: null, activeInteraction: null })
    hook.rerender({ visiblePath: '/repo', activeInteraction: null })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(refreshTree).toHaveBeenCalledOnce()
    expect(refreshDir).not.toHaveBeenCalled()
  })
  it.each(['rename', 'drag', 'native'] as const)(
    'does not refresh the current root on reopen after foreign events during %s',
    async (interaction) => {
      const hook = renderWatch('/repo', interaction)
      const handler = mainWatchHandler
      if (!handler) {
        throw new Error('Filesystem listener was not registered')
      }
      act(() => {
        for (const worktreePath of ['/other-repo', '/repo-sibling']) {
          handler({
            worktreePath,
            events: [{ kind: 'overflow', absolutePath: worktreePath }]
          })
        }
      })
      hook.rerender({ visiblePath: null, activeInteraction: null })
      hook.rerender({ visiblePath: '/repo', activeInteraction: null })
      await act(async () => vi.advanceTimersByTimeAsync(0))

      expect(refreshTree).not.toHaveBeenCalled()
      expect(refreshDir).not.toHaveBeenCalled()
    }
  )

  it.each(['rename', 'drag', 'native'] as const)(
    'preserves current-root refreshes deferred during %s',
    async (interaction) => {
      const hook = renderWatch('/repo', interaction)
      const handler = mainWatchHandler
      if (!handler) {
        throw new Error('Filesystem listener was not registered')
      }
      act(() => emit(handler))
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(refreshDir).not.toHaveBeenCalled()

      hook.rerender({ visiblePath: '/repo', activeInteraction: null })
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(refreshDir).toHaveBeenCalledExactlyOnceWith('/repo')
      expect(refreshTree).not.toHaveBeenCalled()
    }
  )
})

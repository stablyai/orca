// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../../../shared/types'
import type {
  FileExplorerOperationOwner,
  FileExplorerTreeRefreshOutcome
} from './file-explorer-types'

const ownerRef = vi.hoisted(() => ({ current: { kind: 'local' } as FileExplorerOperationOwner }))
const runtimeWatch = vi.hoisted(() => ({
  handler: null as ((payload: FsChangedPayload) => void) | null,
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
    runtimeWatch.handler = null
    runtimeWatch.subscribe.mockReset()
    runtimeWatch.subscribe.mockImplementation(
      async (_context: unknown, handler: WatchHandler): Promise<() => void> => {
        runtimeWatch.handler = handler
        return () => undefined
      }
    )
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

  function renderWatch(worktreePath: string | null = '/repo') {
    return renderHook(
      ({ visiblePath }: { visiblePath: string | null }) =>
        useFileExplorerWatch({
          worktreePath: visiblePath,
          activeWorktreeId: 'wt-1',
          dirCache: { '/repo': { children: [], loading: false } },
          setDirCache: vi.fn(),
          expanded: new Set(),
          setSelectedPath: vi.fn(),
          refreshDir,
          refreshTree,
          inlineInput: null,
          dragSourcePath: null,
          isNativeDragOver: false,
          operationOwner: ownerRef.current
        }),
      { initialProps: { visiblePath: worktreePath } }
    )
  }

  function emit(handler: WatchHandler): void {
    handler({
      worktreePath: '/repo',
      events: [{ kind: 'create', absolutePath: '/repo/new.ts', isDirectory: false }]
    })
  }

  it('resyncs on reopen when hiding Files cancelled a received remote event', async () => {
    ownerRef.current = { kind: 'ssh', connectionId: 'ssh-1' }
    const hook = renderWatch()
    expect(mainWatchHandler).not.toBeNull()

    act(() => emit(mainWatchHandler!))
    hook.rerender({ visiblePath: null })
    hook.rerender({ visiblePath: '/repo' })
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

  it('flushes runtime RPC batches on the next turn without another debounce window', async () => {
    ownerRef.current = {
      kind: 'runtime',
      environmentId: 'runtime-1',
      executionHostId: 'runtime:runtime-1'
    }
    renderWatch()
    expect(runtimeWatch.handler).not.toBeNull()

    act(() => emit(runtimeWatch.handler!))
    expect(refreshDir).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(0))

    expect(refreshDir).toHaveBeenCalledOnce()
  })

  it('resyncs after an event races cleanup of a pending runtime subscription', async () => {
    ownerRef.current = {
      kind: 'runtime',
      environmentId: 'runtime-1',
      executionHostId: 'runtime:runtime-1'
    }
    let releaseSubscription!: () => void
    const subscriptionReady = new Promise<void>((resolve) => {
      releaseSubscription = resolve
    })
    runtimeWatch.subscribe.mockImplementation(
      async (_context: unknown, handler: WatchHandler): Promise<() => void> => {
        runtimeWatch.handler = handler
        await subscriptionReady
        return () => undefined
      }
    )
    const hook = renderWatch()
    const disposedHandler = runtimeWatch.handler!

    hook.rerender({ visiblePath: null })
    hook.rerender({ visiblePath: '/repo' })
    act(() => emit(disposedHandler))
    await act(async () => vi.advanceTimersByTimeAsync(0))

    expect(refreshTree).toHaveBeenCalledOnce()
    expect(refreshDir).not.toHaveBeenCalled()

    await act(async () => {
      releaseSubscription()
      await subscriptionReady
    })
  })
})

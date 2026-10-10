// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { useFileExplorerWatch } from './useFileExplorerWatch'

const owner = vi.hoisted((): { current: FileExplorerOperationOwner } => ({
  current: { kind: 'runtime', environmentId: 'host-a', executionHostId: 'runtime:host-a' }
}))
const runtime = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({})
  })
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => owner.current,
  getFileExplorerOperationOwnerFromState: () => owner.current
}))
vi.mock('@/runtime/runtime-file-client', () => ({ subscribeRuntimeFileChanges: runtime.subscribe }))

const refreshDir = vi.fn(async () => {})
const refreshTree = vi.fn(async () => 'refreshed' as const)
function renderWatch() {
  return renderHook(() =>
    useFileExplorerWatch({
      worktreePath: '/repo',
      activeWorktreeId: 'wt',
      dirCache: { '/repo': { children: [] } },
      setDirCache: vi.fn(),
      expanded: new Set(),
      setSelectedPath: vi.fn(),
      refreshDir,
      refreshTree,
      inlineInput: null,
      dragSourcePath: null,
      isNativeDragOver: false
    })
  )
}
function emit(
  runtimeEnvironmentId: string | null = 'host-a',
  worktreePath = '/repo',
  overflow = false
): void {
  const payload: FsChangedPayload = {
    worktreePath,
    events: [
      {
        kind: overflow ? 'overflow' : 'create',
        absolutePath: overflow ? worktreePath : `${worktreePath}/new.ts`,
        isDirectory: false
      }
    ]
  }
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
        detail: { payload, runtimeEnvironmentId }
      })
    )
  })
}
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  runtime.subscribe.mockResolvedValue(vi.fn())
  owner.current = { kind: 'runtime', environmentId: 'host-a', executionHostId: 'runtime:host-a' }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: { onFsChanged: vi.fn(() => vi.fn()) }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('remote file explorer using the recovered app watcher', () => {
  it('refreshes from the app broker without opening an independent remote subscription', async () => {
    renderWatch()
    emit()
    await settle()
    expect(refreshDir).toHaveBeenCalledExactlyOnceWith('/repo')
    expect(runtime.subscribe).not.toHaveBeenCalled()
  })

  it('ignores other hosts and roots, including an identical local path', async () => {
    renderWatch()
    emit('host-b')
    emit(null)
    emit('host-a', '/other', true)
    emit('host-a', '/repo-sibling', true)
    await settle()
    expect(refreshDir).not.toHaveBeenCalled()
    expect(refreshTree).not.toHaveBeenCalled()
    emit()
    await settle()
    expect(refreshDir).toHaveBeenCalledOnce()
  })

  it('rereads the whole tree after the watcher recovers with an overflow', async () => {
    renderWatch()
    emit('host-a', '/repo', true)
    await settle()
    expect(refreshTree).toHaveBeenCalledOnce()
  })

  it('changes owners without retaining the old listener and removes the listener on unmount', async () => {
    const hook = renderWatch()
    owner.current = { kind: 'runtime', environmentId: 'host-b', executionHostId: 'runtime:host-b' }
    hook.rerender()
    emit('host-a')
    await settle()
    expect(refreshDir).not.toHaveBeenCalled()
    emit('host-b')
    await settle()
    expect(refreshDir).toHaveBeenCalledOnce()
    hook.unmount()
    emit('host-b')
    await settle()
    expect(refreshDir).toHaveBeenCalledOnce()
  })
})

// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  markWorktreeCatchUpPayload,
  ORCA_WORKTREE_FILE_CHANGE_EVENT
} from '@/hooks/worktree-file-change-event'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import { useFileExplorerWatch } from './useFileExplorerWatch'

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({ openFiles: [] })
  })
}))
vi.mock('./file-explorer-operation-owner', () => {
  const owner = { kind: 'local', executionHostId: 'local' }
  return {
    getFileExplorerOperationOwner: () => owner,
    getFileExplorerOperationOwnerFromState: () => owner
  }
})

const refreshDir = vi.fn(async () => {})
const refreshTree = vi.fn(async () => 'refreshed' as const)
const ROOT = '/repo'

function dispatch(payload: FsChangedPayload, runtimeEnvironmentId: string | null = null): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, { detail: { payload, runtimeEnvironmentId } })
  )
}

const overflow = (): FsChangedPayload => ({
  worktreePath: ROOT,
  events: [{ kind: 'overflow', absolutePath: ROOT }]
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { onFsChanged: vi.fn(() => vi.fn()) } }
  })
  renderHook(() =>
    useFileExplorerWatch({
      worktreePath: ROOT,
      activeWorktreeId: 'wt',
      dirCache: { [ROOT]: { children: [] } },
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
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('refreshes a local Files tree on the catch-up sent when its workspace is watched again', async () => {
  act(() => dispatch(markWorktreeCatchUpPayload(overflow())))
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(refreshTree).toHaveBeenCalledTimes(1)
})

it('leaves ordinary bus events to the IPC listener so nothing is processed twice', async () => {
  act(() => dispatch(overflow()))
  act(() => dispatch(markWorktreeCatchUpPayload(overflow()), 'env-1'))
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(refreshTree).not.toHaveBeenCalled()
})

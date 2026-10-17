// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  seedRemoteDropWorkspaces,
  sshConnectionStatesAt,
  SSH_WORKTREE_PATH,
  RUNTIME_WORKTREE_PATH
} from '@/lib/remote-workspace-drop-test-fixtures'
import { getFileExplorerOperationOwner } from './file-explorer-operation-owner'
import { useFileExplorerImagePaste } from './use-file-explorer-image-paste'
import type { ClipboardImageImport } from '../../../../shared/clipboard-image-import'
import {
  clearFileExplorerUndoHistory,
  undoFileExplorer,
  fileExplorerHasUndo
} from './fileExplorerUndoRedo'

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
  release: vi.fn(),
  importPaths: vi.fn(),
  deletePath: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/runtime/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  deleteRuntimePath: mocks.deletePath
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
const snapshot = { handle: 'snapshot', path: 'C:\\staging\\pasted-image.png' }
const refreshDir = vi.fn().mockResolvedValue(undefined)
const setSelectedPath = vi.fn()

function setup(worktreeId = 'wt-ssh', worktreePath = SSH_WORKTREE_PATH) {
  return renderHook(() =>
    useFileExplorerImagePaste({
      worktreeId,
      worktreePath,
      displayRootPath: `${worktreePath}/images`,
      selectedNode: null,
      operationOwner: getFileExplorerOperationOwner(worktreeId),
      refreshDir,
      setSelectedPath
    })
  )
}
function pendingStage() {
  let resolve: (value: ClipboardImageImport) => void = () => undefined
  mocks.stage.mockReturnValueOnce(
    new Promise<ClipboardImageImport>((done) => {
      resolve = done
    })
  )
  return () => resolve(snapshot)
}
beforeEach(() => {
  vi.resetAllMocks()
  seedRemoteDropWorkspaces()
  mocks.stage.mockResolvedValue(snapshot)
  mocks.release.mockResolvedValue(true)
  mocks.importPaths.mockImplementation(async (_context, _paths, dir) => ({
    results: [{ status: 'imported', destPath: `${dir}/pasted-image.png` }]
  }))
  vi.stubGlobal('api', {
    ui: { stageClipboardImageForImport: mocks.stage, releaseClipboardImageImport: mocks.release }
  })
})
afterEach(async () => {
  clearFileExplorerUndoHistory()
  await Promise.resolve()
  cleanup()
  vi.unstubAllGlobals()
})

it('pins the SSH owner and generation before staging a local clipboard image', async () => {
  const { result } = setup()
  await act(() => result.current.pasteImage())
  expect(mocks.importPaths).toHaveBeenCalledWith(
    expect.objectContaining({
      worktreeId: 'wt-ssh',
      worktreePath: SSH_WORKTREE_PATH,
      target: { kind: 'local' },
      connectionId: 'ssh-1',
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 3
    }),
    [snapshot.path],
    `${SSH_WORKTREE_PATH}/images`,
    { assertCurrent: expect.any(Function), requireExistingDestination: true }
  )
  expect(mocks.release).not.toHaveBeenCalled()
  await act(() => undoFileExplorer())
  expect(mocks.deletePath).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ connectionId: 'ssh-1', expectedSshConnectionGeneration: 3 }),
    `${SSH_WORKTREE_PATH}/images/pasted-image.png`,
    false
  )
})

it('refuses undo after SSH reconnects without losing its history step', async () => {
  const { result } = setup()
  await act(() => result.current.pasteImage())
  useAppStore.setState({ sshConnectionStates: sshConnectionStatesAt(4) })
  await expect(undoFileExplorer()).rejects.toThrow()
  expect(mocks.deletePath).not.toHaveBeenCalled()
  expect(fileExplorerHasUndo()).toBe(true)
})

it('uses the runtime owning the workspace while another runtime has focus', async () => {
  const { result } = setup('wt-runtime', RUNTIME_WORKTREE_PATH)
  await act(() => result.current.pasteImage())
  expect(mocks.importPaths.mock.calls[0][0]).toMatchObject({
    worktreeId: 'wt-runtime',
    target: { kind: 'environment', environmentId: 'owner-runtime' }
  })
})

it('refuses an unresolved SSH connection before staging', async () => {
  useAppStore.setState({ sshConnectionStates: new Map() })
  const { result } = setup()
  await act(() => result.current.pasteImage())
  expect(mocks.stage).not.toHaveBeenCalled()
  expect(mocks.importPaths).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledTimes(1)
})

it('cancels before import and releases the snapshot when SSH reconnects during staging', async () => {
  const finish = pendingStage()
  const { result } = setup()
  let operation: Promise<void> | undefined
  act(() => {
    operation = result.current.pasteImage()
  })
  useAppStore.setState({ sshConnectionStates: sshConnectionStatesAt(4) })
  await act(async () => {
    finish()
    await operation
  })
  expect(mocks.importPaths).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledTimes(1)
  expect(mocks.release).toHaveBeenCalledWith(snapshot.handle)
})

it('cancels when the workspace changes owner while the snapshot is being prepared', async () => {
  const finish = pendingStage()
  const { result } = setup()
  let operation: Promise<void> | undefined
  act(() => {
    operation = result.current.pasteImage()
  })
  useAppStore.setState((state) => ({
    repos: state.repos.map((repo) =>
      repo.id === 'repo-ssh'
        ? { ...repo, connectionId: null, executionHostId: 'local' as const }
        : repo
    )
  }))
  await act(async () => {
    finish()
    await operation
  })
  expect(mocks.importPaths).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledTimes(1)
  expect(mocks.release).toHaveBeenCalledWith(snapshot.handle)
})

it('does not refresh or select on a reconnected host after import returns', async () => {
  mocks.importPaths.mockImplementationOnce(async () => {
    useAppStore.setState({ sshConnectionStates: sshConnectionStatesAt(4) })
    return {
      results: [{ status: 'imported', destPath: `${SSH_WORKTREE_PATH}/images/pasted-image.png` }]
    }
  })
  const { result } = setup()
  await act(() => result.current.pasteImage())
  expect(refreshDir).not.toHaveBeenCalled()
  expect(setSelectedPath).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledWith(snapshot.handle)
})

// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedDroppedPaths } from '../../../../shared/native-file-drop-preparation'
import { useAppStore } from '@/store'
import {
  RUNTIME_WORKTREE_PATH as RUNTIME_ROOT,
  seedRemoteDropWorkspaces,
  sshConnectionStatesAt,
  SSH_WORKTREE_PATH as SSH_ROOT
} from '@/lib/remote-workspace-drop-test-fixtures'
import { joinPath } from '@/lib/path'
import { getFileExplorerOperationOwner } from './file-explorer-operation-owner'
import { useFileExplorerImport } from './useFileExplorerImport'

const mocks = vi.hoisted(() => ({
  importPaths: vi.fn(),
  prepare: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const refreshDir = vi.fn().mockResolvedValue(undefined)
const clearDrag = vi.fn()
const setSelected = vi.fn()

function Explorer({ worktreeId, root }: { worktreeId: string; root: string }) {
  // Like the tree pane, the owner is the one the tree root loaded with.
  const ownerRef = useFileExplorerImport({
    worktreeId,
    worktreePath: root,
    displayRootPath: root,
    refreshDir,
    clearNativeDragState: clearDrag,
    setSelectedPath: setSelected,
    operationOwner: getFileExplorerOperationOwner(worktreeId)
  })
  const srcDir = joinPath(root, 'src')
  return (
    <div ref={ownerRef} data-testid="tree">
      <button data-testid="src" data-file-explorer-drop-dir={srcDir} />
    </div>
  )
}

function dropFile(target: Element): void {
  const transfer = { types: ['Files'], files: [new File(['x'], 'shot.png')], dropEffect: 'move' }
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: true })
  act(() => {
    target.dispatchEvent(event)
  })
}

beforeEach(() => {
  seedRemoteDropWorkspaces()
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  mocks.importPaths.mockImplementation(async (_context, _paths, dir: string) => ({
    results: [{ status: 'imported', destPath: joinPath(dir, 'shot.png') }]
  }))
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/Users/me/Desktop/${file.name}`,
      prepareDroppedPaths: mocks.prepare
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('file explorer OS file drops on remote workspaces', () => {
  it('uploads into the SSH folder the drop landed on', async () => {
    const view = render(<Explorer worktreeId="wt-ssh" root={SSH_ROOT} />)
    dropFile(view.getByTestId('src'))
    await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
    const [context, paths, dir] = mocks.importPaths.mock.calls[0]
    expect(context).toMatchObject({
      worktreeId: 'wt-ssh',
      worktreePath: SSH_ROOT,
      connectionId: 'ssh-1',
      target: { kind: 'local' },
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 3
    })
    expect(paths).toEqual(['/Users/me/Desktop/shot.png'])
    expect(dir).toBe(joinPath(SSH_ROOT, 'src'))
  })

  it("uploads through the workspace's own runtime, not the focused one", async () => {
    const view = render(<Explorer worktreeId="wt-runtime" root={RUNTIME_ROOT} />)
    dropFile(view.getByTestId('src'))
    await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
    expect(mocks.importPaths.mock.calls[0][0]).toMatchObject({
      worktreeId: 'wt-runtime',
      target: { kind: 'environment', environmentId: 'owner-runtime' }
    })
    expect(mocks.importPaths.mock.calls[0][2]).toBe(joinPath(RUNTIME_ROOT, 'src'))
  })

  it('refuses after preparation when the SSH connection changed', async () => {
    let finish: (prepared: PreparedDroppedPaths) => void = () => undefined
    mocks.prepare.mockImplementationOnce(
      () => new Promise<PreparedDroppedPaths>((resolve) => (finish = resolve))
    )
    const view = render(<Explorer worktreeId="wt-ssh" root={SSH_ROOT} />)
    dropFile(view.getByTestId('src'))
    useAppStore.setState({ sshConnectionStates: sshConnectionStatesAt(4) })
    await act(async () => finish({ paths: ['/Users/me/Desktop/shot.png'], failures: [] }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(clearDrag).toHaveBeenCalled()
  })

  it('reports a host that could not be verified at drop time once preparation finishes', async () => {
    let finish: (prepared: PreparedDroppedPaths) => void = () => undefined
    mocks.prepare.mockImplementationOnce(
      () => new Promise<PreparedDroppedPaths>((resolve) => (finish = resolve))
    )
    // A disconnected SSH host has no connection generation to pin the upload to.
    useAppStore.setState({ sshConnectionStates: new Map() })
    const view = render(<Explorer worktreeId="wt-ssh" root={SSH_ROOT} />)
    dropFile(view.getByTestId('src'))
    expect(mocks.toastError).not.toHaveBeenCalled()
    await act(async () => finish({ paths: ['/Users/me/Desktop/shot.png'], failures: [] }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(clearDrag).toHaveBeenCalled()
  })
})

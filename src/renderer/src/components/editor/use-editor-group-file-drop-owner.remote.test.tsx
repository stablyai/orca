// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedDroppedPaths } from '../../../../shared/native-file-drop-preparation'
import { useAppStore } from '@/store'
import {
  RUNTIME_WORKTREE_PATH as RUNTIME_PATH,
  seedRemoteDropWorkspaces,
  sshConnectionStatesAt,
  SSH_WORKTREE_PATH as SSH_PATH
} from '@/lib/remote-workspace-drop-test-fixtures'
import { joinPath } from '@/lib/path'
import { useEditorGroupFileDropOwner } from './use-editor-group-file-drop-owner'

const mocks = vi.hoisted(() => ({
  importPaths: vi.fn(),
  prepare: vi.fn(),
  openFile: vi.fn(),
  setActiveTabType: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))

function EditorStrip({ worktreeId, groupId }: { worktreeId: string; groupId: string }) {
  const attach = useEditorGroupFileDropOwner({ worktreeId, groupId })
  return <div ref={attach} data-testid="strip" />
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
  useAppStore.setState({ openFile: mocks.openFile, setActiveTabType: mocks.setActiveTabType })
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  mocks.importPaths.mockImplementation(async (_context, paths: string[], dir: string) => ({
    results: paths.map((path) => ({
      status: 'imported',
      kind: 'file',
      destPath: joinPath(dir, path.split('/').pop() ?? path)
    }))
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

describe('editor group OS file drops on remote workspaces', () => {
  it("uploads an SSH group's drop into that workspace and opens it in that group", async () => {
    const view = render(<EditorStrip worktreeId="wt-ssh" groupId="group-ssh" />)
    dropFile(view.getByTestId('strip'))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
    const [context, paths, dir] = mocks.importPaths.mock.calls[0]
    expect(context).toMatchObject({
      worktreeId: 'wt-ssh',
      worktreePath: SSH_PATH,
      connectionId: 'ssh-1',
      settings: { activeRuntimeEnvironmentId: null },
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 3
    })
    expect(paths).toEqual(['/Users/me/Desktop/shot.png'])
    expect(dir).toBe(joinPath(SSH_PATH, '.orca/drops'))
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: joinPath(SSH_PATH, '.orca/drops/shot.png'),
        worktreeId: 'wt-ssh'
      }),
      { suppressActiveRuntimeFallback: true, targetGroupId: 'group-ssh' }
    )
  })

  it("uploads through the workspace's own runtime, not the focused one", async () => {
    const view = render(<EditorStrip worktreeId="wt-runtime" groupId="group-runtime" />)
    dropFile(view.getByTestId('strip'))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
    expect(mocks.importPaths.mock.calls[0][0]).toMatchObject({
      worktreeId: 'wt-runtime',
      settings: { activeRuntimeEnvironmentId: 'owner-runtime' }
    })
    expect(mocks.importPaths.mock.calls[0][2]).toBe(joinPath(RUNTIME_PATH, '.orca/drops'))
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-runtime', runtimeEnvironmentId: 'owner-runtime' }),
      { suppressActiveRuntimeFallback: false, targetGroupId: 'group-runtime' }
    )
  })

  it.each(['wt-ssh', 'wt-runtime'])(
    'opens nothing when the group closes during upload in %s and keeps preparation feedback',
    async (worktreeId) => {
      let finish: (result: {
        results: { status: 'imported'; kind: 'file'; destPath: string }[]
      }) => void = () => undefined
      mocks.importPaths.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      mocks.prepare.mockResolvedValueOnce({
        paths: ['/Users/me/Desktop/shot.png'],
        failures: [{ target: 'rejected', reason: 'unresolved-paths', pathCount: 1, byteLength: 0 }]
      })
      const groupId = worktreeId === 'wt-ssh' ? 'group-ssh' : 'group-runtime'
      const view = render(<EditorStrip worktreeId={worktreeId} groupId={groupId} />)
      dropFile(view.getByTestId('strip'))
      await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
      view.unmount()
      useAppStore.setState((state) => ({
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: [{ id: 'group-other', worktreeId, activeTabId: null, tabOrder: [] }]
        }
      }))
      await act(async () =>
        finish({ results: [{ status: 'imported', kind: 'file', destPath: '/uploaded/shot.png' }] })
      )
      expect(mocks.openFile).not.toHaveBeenCalled()
      expect(mocks.setActiveTabType).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses when the SSH connection changes before preparation finishes', async () => {
    let finish: (prepared: PreparedDroppedPaths) => void = () => undefined
    mocks.prepare.mockImplementationOnce(
      () => new Promise<PreparedDroppedPaths>((resolve) => (finish = resolve))
    )
    const view = render(<EditorStrip worktreeId="wt-ssh" groupId="group-ssh" />)
    dropFile(view.getByTestId('strip'))
    // A reconnect is a new connection generation: the captured host no longer holds.
    useAppStore.setState({ sshConnectionStates: sshConnectionStatesAt(4) })
    await act(async () => finish({ paths: ['/Users/me/Desktop/shot.png'], failures: [] }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError.mock.calls[0][0]).toMatch(/Couldn't verify which host owns/)
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('refuses when the workspace runtime owner changes before preparation finishes', async () => {
    let finish: (prepared: PreparedDroppedPaths) => void = () => undefined
    mocks.prepare.mockImplementationOnce(
      () => new Promise<PreparedDroppedPaths>((resolve) => (finish = resolve))
    )
    const view = render(<EditorStrip worktreeId="wt-runtime" groupId="group-runtime" />)
    dropFile(view.getByTestId('strip'))
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) =>
        repo.id === 'repo-rt' ? { ...repo, executionHostId: 'runtime:new-owner' as const } : repo
      )
    }))
    await act(async () => finish({ paths: ['/Users/me/Desktop/shot.png'], failures: [] }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError.mock.calls[0][0]).toMatch(/Couldn't verify which host owns/)
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
  })
})

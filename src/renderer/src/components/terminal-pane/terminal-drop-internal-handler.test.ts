import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastLoading: vi.fn(() => 'toast-1'),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  importExternalPathsToRuntime: vi.fn(),
  resolveDroppedPathsForAgent: vi.fn(),
  recordTerminalUserInputForLeaf: vi.fn(),
  storeState: {
    activeRepoId: 'repo1',
    activeWorktreeId: 'wt-1',
    settings: { activeRuntimeEnvironmentId: 'env-1' as string | null },
    projects: [
      {
        id: 'repo1',
        localWindowsRuntimePreference: { kind: 'inherit-global' as const }
      }
    ] as {
      id: string
      localWindowsRuntimePreference:
        | { kind: 'inherit-global' }
        | { kind: 'windows-host' }
        | { kind: 'wsl'; distro: string | null }
    }[],
    repos: [
      {
        id: 'repo1',
        connectionId: null as string | null,
        path: '/remote/repo',
        executionHostId: 'runtime:env-1' as string | null
      }
    ],
    worktreesByRepo: {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo' }]
    },
    sshConnectionStates: new Map<string, { remotePlatform?: NodeJS.Platform }>()
  }
}))

vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    message: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importExternalPathsToRuntime
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

import { encodeWorkspaceFilePaths, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'

function createTerminalTransport(
  sendInput: ReturnType<typeof vi.fn>,
  ptyId = 'pty-1',
  sendInputAccepted?: ReturnType<typeof vi.fn>
) {
  return {
    sendInput,
    ...(sendInputAccepted ? { sendInputAccepted } : {}),
    getPtyId: vi.fn(() => ptyId),
    isConnected: vi.fn(() => true)
  }
}

describe('handleInternalTerminalFileDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/repo', executionHostId: 'local' }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/repo' }]
    }
    mocks.storeState.sshConnectionStates = new Map()
  })

  it('pastes every selected internal file path with shell spacing', async () => {
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, leafId: 'leaf-1', terminal: { focus } }),
      getPanes: () => []
    }
    const paths = ['/repo/a.ts', '/repo/my file.ts']

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME ? encodeWorkspaceFilePaths(paths) : ''
      }
    })

    expect(result).toEqual({ status: 'pasted', pathCount: 2 })
    expect(sendInput.mock.calls).toEqual([['/repo/a.ts '], ["'/repo/my file.ts' "]])
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(focus).toHaveBeenCalled()
  })

  it('stops internal file-drop paste when the target transport changes between paths', async () => {
    const sendInput = vi.fn(() => true)
    const replacementSendInput = vi.fn(() => true)
    const paneTransports = new Map<number, ReturnType<typeof createTerminalTransport>>()
    const replacementTransport = createTerminalTransport(replacementSendInput, 'pty-2')
    const sendInputAccepted = vi.fn(async () => {
      paneTransports.set(1, replacementTransport)
      return true
    })
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const originalTransport = createTerminalTransport(sendInput, 'pty-1', sendInputAccepted)
    paneTransports.set(1, originalTransport)

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME
            ? encodeWorkspaceFilePaths(['/repo/a.ts', '/repo/b.ts'])
            : ''
      }
    })

    expect(result).toEqual({ status: 'cancelled', reason: 'target-stale', pathCount: 1 })
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(sendInputAccepted).toHaveBeenCalledWith('/repo/a.ts ')
    expect(sendInput).not.toHaveBeenCalled()
    expect(replacementSendInput).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('uses acknowledged PTY writes for internal file drops when available', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, leafId: 'leaf-1', terminal: { focus } }),
      getPanes: () => []
    }

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([
        [1, createTerminalTransport(sendInput, 'pty-1', sendInputAccepted)]
      ]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME ? encodeWorkspaceFilePaths(['/repo/a.ts']) : ''
      }
    })

    expect(result).toEqual({ status: 'pasted', pathCount: 1 })
    expect(sendInputAccepted).toHaveBeenCalledWith('/repo/a.ts ')
    expect(sendInput).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(focus).toHaveBeenCalled()
  })

  it('does not paste internal paths when connection metadata is not hydrated', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: null }
    mocks.storeState.repos = []
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, leafId: 'leaf-1', terminal: { focus } }),
      getPanes: () => []
    }

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME ? encodeWorkspaceFilePaths(['/repo/a.ts']) : ''
      }
    })

    expect(result).toEqual({ status: 'ignored', reason: 'worktree-unavailable' })
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Worktree not ready — try again in a moment.')
  })

  it('uses the terminal worktree owner runtime instead of the focused runtime', async () => {
    mocks.storeState.repos = [
      {
        id: 'repo1',
        connectionId: null,
        path: 'C:\\repo',
        executionHostId: 'runtime:owner-runtime'
      }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: 'C:\\repo' }]
    }
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, leafId: 'leaf-1', terminal: { focus } }),
      getPanes: () => []
    }

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME ? encodeWorkspaceFilePaths(['C:\\repo\\a&b.txt']) : ''
      }
    })

    expect(result).toEqual({ status: 'pasted', pathCount: 1 })
    expect(sendInput).toHaveBeenCalledWith('"C:\\repo\\a&b.txt" ')
  })

  it('uses SSH remote platform metadata for Windows internal file drops', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: null }
    mocks.storeState.repos = [
      {
        id: 'repo1',
        connectionId: 'ssh-win',
        path: 'C:\\Remote Repo',
        executionHostId: 'ssh:ssh-win'
      }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: 'C:\\Remote Repo' }]
    }
    mocks.storeState.sshConnectionStates = new Map([['ssh-win', { remotePlatform: 'win32' }]])
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, leafId: 'leaf-1', terminal: { focus } }),
      getPanes: () => []
    }

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME
            ? encodeWorkspaceFilePaths(['C:\\Remote Repo\\A&B.txt'])
            : ''
      }
    })

    expect(result).toEqual({ status: 'pasted', pathCount: 1 })
    expect(sendInput).toHaveBeenCalledWith('"C:\\Remote Repo\\A&B.txt" ')
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(focus).toHaveBeenCalled()
  })

  it('keeps SSH Linux internal file drops on POSIX shell escaping', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: null }
    mocks.storeState.repos = [
      {
        id: 'repo1',
        connectionId: 'ssh-linux',
        path: '/remote/repo',
        executionHostId: 'ssh:ssh-linux'
      }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo' }]
    }
    mocks.storeState.sshConnectionStates = new Map([['ssh-linux', { remotePlatform: 'linux' }]])
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, leafId: 'leaf-1', terminal: { focus } }),
      getPanes: () => []
    }

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME
            ? encodeWorkspaceFilePaths(["/remote/repo/it's here.txt"])
            : ''
      }
    })

    expect(result).toEqual({ status: 'pasted', pathCount: 1 })
    expect(sendInput).toHaveBeenCalledWith("'/remote/repo/it'\\''s here.txt' ")
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(focus).toHaveBeenCalled()
  })

  it('pastes internal paths into the pane under the drop target instead of the active pane', async () => {
    const activeSendInput = vi.fn(() => true)
    const targetSendInput = vi.fn(() => true)
    const activeFocus = vi.fn()
    const targetFocus = vi.fn()
    const dropTarget: EventTarget = {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
      removeEventListener: vi.fn()
    }
    const activePane = {
      id: 1,
      leafId: 'leaf-active',
      terminal: { focus: activeFocus },
      container: { contains: vi.fn(() => false) }
    }
    const targetPane = {
      id: 2,
      leafId: 'leaf-target',
      terminal: { focus: targetFocus },
      container: { contains: vi.fn((target) => target === dropTarget) }
    }
    const manager = {
      getActivePane: () => activePane,
      getPanes: () => [activePane, targetPane]
    }

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([
        [1, createTerminalTransport(activeSendInput)],
        [2, createTerminalTransport(targetSendInput)]
      ]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME
            ? encodeWorkspaceFilePaths(['/repo/drop-target.ts'])
            : ''
      },
      dropTarget
    })

    expect(result).toEqual({ status: 'pasted', pathCount: 1 })
    expect(activeSendInput).not.toHaveBeenCalled()
    expect(activeFocus).not.toHaveBeenCalled()
    expect(targetSendInput).toHaveBeenCalledWith('/repo/drop-target.ts ')
    expect(targetFocus).toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-target')
  })

  it('rejects too many internal paths before writing terminal input', async () => {
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, leafId: 'leaf-1', terminal: { focus } }),
      getPanes: () => []
    }
    const paths = Array.from({ length: 257 }, (_value, index) =>
      ['/repo/secret-', String(index), '.txt'].join('')
    )

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_PATHS_MIME ? encodeWorkspaceFilePaths(paths) : ''
      }
    })

    expect(result).toEqual({ status: 'rejected', reason: 'too-many-paths' })
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Drop contains too many paths for a safe terminal paste.'
    )
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain('secret-')
  })
})

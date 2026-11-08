import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const worktreesByRepo: Record<
    string,
    { id: string; repoId: string; path: string; hostId?: string | null }[]
  > = {
    repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo', hostId: 'runtime:env-1' }]
  }
  const projects: {
    id: string
    localWindowsRuntimePreference:
      | { kind: 'inherit-global' }
      | { kind: 'windows-host' }
      | { kind: 'wsl'; distro: string | null }
  }[] = [
    {
      id: 'repo1',
      localWindowsRuntimePreference: { kind: 'inherit-global' as const }
    }
  ]

  return {
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
      projects,
      repos: [
        {
          id: 'repo1',
          connectionId: null as string | null,
          path: '/remote/repo',
          executionHostId: 'runtime:env-1' as string | null
        }
      ],
      worktreesByRepo,
      sshConnectionStates: new Map<
        string,
        { remotePlatform?: NodeJS.Platform; connectionGeneration?: number }
      >()
    }
  }
})

vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    message: vi.fn()
  }
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/runtime/files/imports/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.importExternalPathsToRuntime
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

vi.mock('../terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

import './terminal-drop-handler'
import { handleNativeTerminalFileDrop as handleTerminalFileDrop } from './terminal-native-file-drop-destination'
import '../paste/terminal-bracketed-paste'

function createTerminalTransport(
  sendInput: ReturnType<typeof vi.fn>,
  ptyId = 'pty-1',
  sendInputAccepted?: ReturnType<typeof vi.fn>
) {
  const host = parseExecutionHostId(mocks.storeState.repos[0]?.executionHostId)
  return {
    sendInput,
    ...(sendInputAccepted ? { sendInputAccepted } : {}),
    getPtyId: vi.fn(() => ptyId),
    isConnected: vi.fn(() => true),
    getExecutionHostId: () => (host?.kind === 'runtime' ? 'local' : (host?.id ?? 'local')),
    getRuntimeEnvironmentId: () => (host?.kind === 'runtime' ? host.environmentId : null)
  }
}

describe('handleTerminalFileDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.activeRepoId = 'repo1'
    mocks.storeState.activeWorktreeId = 'wt-1'
    vi.stubGlobal('window', {
      api: {
        fs: {
          resolveDroppedPathsForAgent: mocks.resolveDroppedPathsForAgent
        }
      }
    })
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }
    mocks.storeState.projects = [
      {
        id: 'repo1',
        localWindowsRuntimePreference: { kind: 'inherit-global' }
      }
    ]
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/remote/repo', executionHostId: 'runtime:env-1' }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [
        {
          id: 'wt-1',
          repoId: 'repo1',
          path: '/remote/repo',
          hostId: parseExecutionHostId(mocks.storeState.repos[0]?.executionHostId)?.id ?? 'local'
        }
      ]
    }
    mocks.storeState.sshConnectionStates = new Map()
  })

  it('does not paste runtime-uploaded paths when the target PTY changed', async () => {
    let ptyId = 'pty-1'
    mocks.importExternalPathsToRuntime.mockImplementation(async () => {
      ptyId = 'pty-2'
      return {
        results: [
          {
            sourcePath: '/Users/me/logo.png',
            status: 'imported',
            destPath: '/remote/repo/.orca/drops/logo.png',
            kind: 'file',
            renamed: false
          }
        ]
      }
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = { getActivePane: () => pane, getPanes: () => [pane] }
    const transport = createTerminalTransport(sendInput)
    transport.getPtyId.mockImplementation(() => ptyId)

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, transport]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      pane,
      paths: ['/Users/me/logo.png']
    })

    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('does not paste local WSL resolved paths when the target PTY changed', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/repo', executionHostId: 'local' }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [
        {
          id: 'wt-1',
          repoId: 'repo1',
          path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo'
        }
      ]
    }
    let ptyId = 'pty-1'
    mocks.resolveDroppedPathsForAgent.mockImplementation(async () => {
      ptyId = 'pty-2'
      return {
        failed: [],
        resolvedPaths: ['/mnt/c/Users/Name/My Project/file.txt'],
        skipped: []
      }
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const transport = createTerminalTransport(sendInput)
    transport.getPtyId.mockImplementation(() => ptyId)

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, transport]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      pane,
      paths: ['C:\\Users\\Name\\My Project\\file.txt']
    })

    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })
})

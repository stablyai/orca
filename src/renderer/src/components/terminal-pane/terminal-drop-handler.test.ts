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
    sshConnectionStates: new Map<
      string,
      { remotePlatform?: NodeJS.Platform; connectionGeneration?: number }
    >()
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

import { handleTerminalFileDrop } from './terminal-drop-handler'
import { wrapTerminalBracketedPasteText } from './terminal-bracketed-paste'

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
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo' }]
    }
    mocks.storeState.sshConnectionStates = new Map()
  })

  it('uploads client-local drops into the active runtime before pasting paths', async () => {
    mocks.importExternalPathsToRuntime.mockResolvedValue({
      results: [
        {
          sourcePath: '/Users/me/logo.png',
          status: 'imported',
          destPath: '/remote/repo/.orca/drops/logo.png',
          kind: 'file',
          renamed: false
        }
      ]
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const paneTransports = new Map([[1, createTerminalTransport(sendInput)]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ['/Users/me/logo.png'], target: 'terminal' }
    })

    expect(mocks.importExternalPathsToRuntime).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo',
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      ['/Users/me/logo.png'],
      '/remote/repo/.orca/drops',
      { assertCurrent: expect.any(Function) }
    )
    expect(sendInput).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('/remote/repo/.orca/drops/logo.png')
    )
    expect(focus).toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
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
      data: { paths: ['/Users/me/logo.png'], target: 'terminal' }
    })

    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('uses Windows shell paths for forward-slash UNC runtime worktrees', async () => {
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '//server/share/repo' }]
    }
    mocks.importExternalPathsToRuntime.mockResolvedValue({
      results: [
        {
          sourcePath: '/Users/me/logo.png',
          status: 'imported',
          destPath: '//server/share/repo\\.orca\\drops\\logo.png',
          kind: 'file',
          renamed: false
        }
      ]
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const paneTransports = new Map([[1, createTerminalTransport(sendInput)]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ['/Users/me/logo.png'], target: 'terminal' }
    })

    expect(mocks.importExternalPathsToRuntime).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '//server/share/repo',
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      ['/Users/me/logo.png'],
      '\\\\server\\share\\repo\\.orca\\drops',
      { assertCurrent: expect.any(Function) }
    )
    expect(sendInput).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('\\\\server\\share\\repo\\.orca\\drops\\logo.png')
    )
  })

  it('uploads to the worktree owner runtime instead of the focused runtime', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.repos = [
      {
        id: 'repo1',
        connectionId: null,
        path: '/remote/repo',
        executionHostId: 'runtime:owner-runtime'
      }
    ]
    mocks.importExternalPathsToRuntime.mockResolvedValue({
      results: [
        {
          sourcePath: '/Users/me/spec.pdf',
          status: 'imported',
          destPath: '/remote/repo/.orca/drops/spec.pdf',
          kind: 'file',
          renamed: false
        }
      ]
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const paneTransports = new Map([[1, createTerminalTransport(sendInput)]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ['/Users/me/spec.pdf'], target: 'terminal' }
    })

    expect(mocks.importExternalPathsToRuntime).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: 'owner-runtime' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo',
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      ['/Users/me/spec.pdf'],
      '/remote/repo/.orca/drops',
      { assertCurrent: expect.any(Function) }
    )
    expect(sendInput).toHaveBeenCalledWith('/remote/repo/.orca/drops/spec.pdf ')
  })

  it('keeps explicit local worktree drops local while a runtime is focused', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/remote/repo', executionHostId: 'local' }
    ]
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const paneTransports = new Map([[1, createTerminalTransport(sendInput)]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ['/Users/me/spec.pdf'], target: 'terminal' }
    })

    expect(mocks.importExternalPathsToRuntime).not.toHaveBeenCalled()
    expect(sendInput).toHaveBeenCalledWith('/Users/me/spec.pdf ')
    expect(focus).toHaveBeenCalled()
  })

  it('pastes Linux-readable paths for local Windows-path projects forced to WSL', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.projects = [
      {
        id: 'repo1',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    mocks.storeState.repos = [
      {
        id: 'repo1',
        connectionId: null,
        path: 'C:\\Users\\alice\\repo',
        executionHostId: 'local'
      }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: 'C:\\Users\\alice\\repo\\feature' }]
    }
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, leafId: 'leaf-1', terminal: { focus } }),
      getPanes: () => []
    }
    const paneTransports = new Map([[1, createTerminalTransport(sendInput)]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: {
        paths: [
          'C:\\Users\\alice\\Desktop\\notes one.txt',
          '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\README.md'
        ],
        target: 'terminal'
      }
    })

    expect(mocks.importExternalPathsToRuntime).not.toHaveBeenCalled()
    expect(sendInput).toHaveBeenNthCalledWith(1, "'/mnt/c/Users/alice/Desktop/notes one.txt' ")
    expect(sendInput).toHaveBeenNthCalledWith(2, '/home/alice/repo/README.md ')
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('uses acknowledged PTY writes for native local drops when available', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/repo', executionHostId: 'local' }
    ]
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const paneTransports = new Map([
      [1, createTerminalTransport(sendInput, 'pty-1', sendInputAccepted)]
    ])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ['/Users/me/spec.pdf'], target: 'terminal' }
    })

    expect(sendInputAccepted).toHaveBeenCalledWith('/Users/me/spec.pdf ')
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('pastes native file drops into the pane identified by the payload leaf id', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/repo', executionHostId: 'local' }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/repo' }]
    }
    const activeSendInput = vi.fn(() => true)
    const targetSendInput = vi.fn(() => true)
    const activeFocus = vi.fn()
    const targetFocus = vi.fn()
    const activePane = { id: 1, leafId: 'leaf-active', terminal: { focus: activeFocus } }
    const targetPane = { id: 2, leafId: 'leaf-target', terminal: { focus: targetFocus } }
    const manager = {
      getActivePane: () => activePane,
      getPanes: () => [activePane, targetPane]
    }

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([
        [1, createTerminalTransport(activeSendInput)],
        [2, createTerminalTransport(targetSendInput)]
      ]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ['/Users/me/spec.pdf'], target: 'terminal', paneLeafId: 'leaf-target' }
    })

    expect(activeSendInput).not.toHaveBeenCalled()
    expect(activeFocus).not.toHaveBeenCalled()
    expect(targetSendInput).toHaveBeenCalledWith('/Users/me/spec.pdf ')
    expect(targetFocus).toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-target')
  })

  it('resolves local WSL drops through the target distro before pasting POSIX paths', async () => {
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
    mocks.resolveDroppedPathsForAgent.mockResolvedValue({
      failed: [],
      resolvedPaths: ['/mnt/c/Users/Name/My Project/file.txt', '/home/user/repo/README.md'],
      skipped: []
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const paneTransports = new Map([[1, createTerminalTransport(sendInput)]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: {
        paths: [
          'C:\\Users\\Name\\My Project\\file.txt',
          '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo\\README.md'
        ],
        target: 'terminal'
      }
    })

    expect(mocks.resolveDroppedPathsForAgent).toHaveBeenCalledWith({
      paths: [
        'C:\\Users\\Name\\My Project\\file.txt',
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo\\README.md'
      ],
      worktreePath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo'
    })
    expect(sendInput.mock.calls).toEqual([
      ["'/mnt/c/Users/Name/My Project/file.txt' "],
      ['/home/user/repo/README.md ']
    ])
    expect(focus).toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
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
      data: { paths: ['C:\\Users\\Name\\My Project\\file.txt'], target: 'terminal' }
    })

    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('uses SSH remote platform metadata for Windows remote path drops', async () => {
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
    mocks.storeState.sshConnectionStates = new Map([
      ['ssh-win', { remotePlatform: 'win32', connectionGeneration: 4 }]
    ])
    mocks.resolveDroppedPathsForAgent.mockResolvedValue({
      failed: [],
      resolvedPaths: ['C:\\Remote Repo\\A&B.txt'],
      skipped: []
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ['C:\\Users\\Name\\A&B.txt'], target: 'terminal' }
    })

    expect(mocks.resolveDroppedPathsForAgent).toHaveBeenCalledWith({
      paths: ['C:\\Users\\Name\\A&B.txt'],
      worktreePath: 'C:\\Remote Repo',
      connectionId: 'ssh-win',
      expectedExecutionHostId: 'ssh:ssh-win',
      expectedSshTargetId: 'ssh-win',
      expectedSshConnectionGeneration: 4
    })
    expect(sendInput).toHaveBeenCalledWith('"C:\\Remote Repo\\A&B.txt" ')
    expect(focus).toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('surfaces stale SSH owner capture failures without rejecting the native drop', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: null }
    mocks.storeState.repos = [
      {
        id: 'repo1',
        connectionId: 'ssh-stale',
        path: '/remote/repo',
        executionHostId: 'ssh:ssh-stale'
      }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo' }]
    }
    mocks.storeState.sshConnectionStates = new Map([['ssh-stale', { remotePlatform: 'linux' }]])
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }

    await expect(
      handleTerminalFileDrop({
        manager: { getActivePane: () => pane, getPanes: () => [pane] } as never,
        paneTransports: new Map([[1, createTerminalTransport(vi.fn(() => true))]]) as never,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        cwd: undefined,
        data: { paths: ['/local/a.txt'], target: 'terminal' }
      })
    ).resolves.toBeUndefined()

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't verify the SSH connection. Reconnect the host and try again."
    )
    expect(mocks.resolveDroppedPathsForAgent).not.toHaveBeenCalled()
  })

  it('keeps SSH Linux path drops on POSIX shell escaping', async () => {
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
    mocks.storeState.sshConnectionStates = new Map([
      ['ssh-linux', { remotePlatform: 'linux', connectionGeneration: 5 }]
    ])
    mocks.resolveDroppedPathsForAgent.mockResolvedValue({
      failed: [],
      resolvedPaths: ["/remote/repo/it's here.txt"],
      skipped: []
    })
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      data: { paths: ["/Users/me/it's here.txt"], target: 'terminal' }
    })

    expect(sendInput).toHaveBeenCalledWith("'/remote/repo/it'\\''s here.txt' ")
  })
})

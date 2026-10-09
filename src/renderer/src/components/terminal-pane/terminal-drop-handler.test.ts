import { parseExecutionHostId } from '../../../../shared/execution-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeImportProgressHandlers } from '@/runtime/runtime-upload-progress-tracker'

const mocks = vi.hoisted(() => {
  const worktreesByRepo: Record<
    string,
    { id: string; repoId: string; path: string; hostId?: string | null }[]
  > = {
    repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo', hostId: 'runtime:env-1' }]
  }
  return {
    toastLoading: vi.fn(() => 'toast-1'),
    toastCustom: vi.fn((_render: unknown, _options?: Record<string, unknown>) => 'toast-1'),
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
    custom: mocks.toastCustom,
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    message: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.storeState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importExternalPathsToRuntime
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'session-1'
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

import {
  endTransferSession,
  getTransferSession
} from '@/components/transfer-progress/transfer-session-state'
import { handleTerminalFileDrop } from './terminal-drop-handler'
import { wrapTerminalBracketedPasteText } from './terminal-bracketed-paste'

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

// Why: the drop panel is only created once rows exist, so a mock that never
// announces a row leaves nothing for the dismissal assertions to observe.
type ImportOptions = { progress?: RuntimeImportProgressHandlers }

const ROW = { uploadId: 'u-1', name: 'logo.png', totalBytes: 10, sourcePath: '/Users/me/logo.png' }

/** A successful import: the row moves all its bytes and settles before the drop finishes. */
function startAndFinishRow(options: ImportOptions | undefined): void {
  const progress = options?.progress
  progress?.onStart([ROW])
  progress?.onRowProgress(ROW.uploadId, ROW.totalBytes)
  progress?.onRowSettled(ROW.uploadId, 'done')
  progress?.onFinish()
}

/** An import that throws mid-drop: rows never settle, the finally still finishes. */
function startRowThenAbort(options: ImportOptions | undefined): void {
  options?.progress?.onStart([ROW])
  options?.progress?.onFinish()
}

function announceRowThenResolve(value: unknown) {
  return async (_context: unknown, _paths: unknown, _dest: unknown, options?: ImportOptions) => {
    startAndFinishRow(options)
    return value
  }
}

const EXPECTED_IMPORT_OPTIONS = {
  assertCurrent: expect.any(Function),
  progress: {
    onStart: expect.any(Function),
    onRowProgress: expect.any(Function),
    onRowSettled: expect.any(Function),
    onFinish: expect.any(Function),
    isCancelled: expect.any(Function)
  }
}

/** Points the store at one SSH-backed repo whose only worktree is `wt-1`. */
function stubSshRepo(
  connectionId: string,
  path: string,
  sshState: { remotePlatform?: NodeJS.Platform; connectionGeneration?: number }
): void {
  mocks.storeState.settings = { activeRuntimeEnvironmentId: null }
  mocks.storeState.repos = [
    { id: 'repo1', connectionId, path, executionHostId: `ssh:${connectionId}` }
  ]
  mocks.storeState.worktreesByRepo = {
    repo1: [{ id: 'wt-1', repoId: 'repo1', path, hostId: `ssh:${connectionId}` }]
  }
  mocks.storeState.sshConnectionStates = new Map([[connectionId, sshState]])
}

function stubLocalRepo(repoPath: string, worktreePath = repoPath): void {
  mocks.storeState.repos = [
    { id: 'repo1', connectionId: null, path: repoPath, executionHostId: 'local' }
  ]
  mocks.storeState.worktreesByRepo = {
    repo1: [{ id: 'wt-1', repoId: 'repo1', path: worktreePath, hostId: 'local' }]
  }
}

describe('handleTerminalFileDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    endTransferSession('session-1')
    mocks.storeState.activeRepoId = 'repo1'
    mocks.storeState.activeWorktreeId = 'wt-1'
    vi.stubGlobal('window', {
      api: {
        fs: {
          resolveDroppedPathsForAgent: mocks.resolveDroppedPathsForAgent,
          onUploadProgress: () => () => {},
          cancelRuntimeUpload: vi.fn().mockResolvedValue(undefined),
          releaseRuntimeUpload: vi.fn().mockResolvedValue(undefined)
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

  it('uploads client-local drops into the active runtime before pasting paths', async () => {
    mocks.importExternalPathsToRuntime.mockImplementation(
      announceRowThenResolve({
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
    )
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = { getActivePane: () => pane, getPanes: () => [pane] }
    const paneTransports = new Map([[1, createTerminalTransport(sendInput)]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      pane,
      paths: ['/Users/me/logo.png']
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
      EXPECTED_IMPORT_OPTIONS
    )
    expect(sendInput).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('/remote/repo/.orca/drops/logo.png'),
      'driving'
    )
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastCustom).toHaveBeenCalled()
    const session = getTransferSession('session-1')
    expect(session?.settled).toBe(true)
    expect(session?.rows).toEqual([expect.objectContaining({ status: 'done', sentBytes: 10 })])
    // The panel holds briefly to show the outcome and dismisses itself; cutting
    // that short here is what made a cancelled drop vanish with nothing to read.
    expect(mocks.toastDismiss).not.toHaveBeenCalled()
  })

  it('does not paste runtime-uploaded paths when the target PTY changed', async () => {
    let ptyId = 'pty-1'
    mocks.importExternalPathsToRuntime.mockImplementation(
      async (_context: unknown, _paths: unknown, _dest: unknown, options?: ImportOptions) => {
        ptyId = 'pty-2'
        startAndFinishRow(options)
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
      }
    )
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
    expect(mocks.toastDismiss).not.toHaveBeenCalled()
  })

  it('publishes the upload panel without an explicit undefined id', async () => {
    mocks.importExternalPathsToRuntime.mockImplementation(announceRowThenResolve({ results: [] }))
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }
    const manager = { getActivePane: () => pane, getPanes: () => [pane] }

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(vi.fn(() => true))]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      pane,
      paths: ['/Users/me/logo.png']
    })

    // Why: sonner spreads these options over the id it just minted, so passing
    // `id: undefined` registers the toast under an id it never returns and every
    // re-issue stacks another panel instead of updating the first.
    expect(mocks.toastCustom).toHaveBeenCalledTimes(1)
    const options = mocks.toastCustom.mock.calls[0]?.[1]
    expect(options).toBeDefined()
    expect(Object.keys(options ?? {})).not.toContain('id')
  })

  it('tears the upload panel down immediately when the import throws', async () => {
    mocks.importExternalPathsToRuntime.mockImplementation(
      async (_context: unknown, _paths: unknown, _dest: unknown, options?: ImportOptions) => {
        startRowThenAbort(options)
        throw new Error('runtime unreachable')
      }
    )
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }
    const manager = { getActivePane: () => pane, getPanes: () => [pane] }

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: new Map([[1, createTerminalTransport(vi.fn(() => true))]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      pane,
      paths: ['/Users/me/logo.png']
    })

    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
    expect(mocks.toastError).toHaveBeenCalled()
    expect(getTransferSession('session-1')).toBeUndefined()
  })

  it('uses Windows shell paths for forward-slash UNC runtime worktrees', async () => {
    mocks.storeState.worktreesByRepo = {
      repo1: [
        {
          id: 'wt-1',
          repoId: 'repo1',
          path: '//server/share/repo',
          hostId: parseExecutionHostId(mocks.storeState.repos[0]?.executionHostId)?.id ?? 'local'
        }
      ]
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
      pane,
      paths: ['/Users/me/logo.png']
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
      EXPECTED_IMPORT_OPTIONS
    )
    expect(sendInput).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('\\\\server\\share\\repo\\.orca\\drops\\logo.png'),
      'driving'
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
    mocks.storeState.worktreesByRepo = {
      repo1: [
        { id: 'wt-1', repoId: 'repo1', path: '/remote/repo', hostId: 'runtime:owner-runtime' }
      ]
    }
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
      pane,
      paths: ['/Users/me/spec.pdf']
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
      EXPECTED_IMPORT_OPTIONS
    )
    expect(sendInput).toHaveBeenCalledWith('/remote/repo/.orca/drops/spec.pdf ', 'driving')
  })

  it('keeps explicit local worktree drops local while a runtime is focused', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    stubLocalRepo('/remote/repo')
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
      pane,
      paths: ['/Users/me/spec.pdf']
    })

    expect(mocks.importExternalPathsToRuntime).not.toHaveBeenCalled()
    expect(sendInput).toHaveBeenCalledWith('/Users/me/spec.pdf ', 'driving')
    expect(focus).not.toHaveBeenCalled()
  })

  it('pastes Linux-readable paths for local Windows-path projects forced to WSL', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.projects = [
      {
        id: 'repo1',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    stubLocalRepo('C:\\Users\\alice\\repo', 'C:\\Users\\alice\\repo\\feature')
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
      pane,
      paths: [
        'C:\\Users\\alice\\Desktop\\notes one.txt',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo\\README.md'
      ]
    })

    expect(mocks.importExternalPathsToRuntime).not.toHaveBeenCalled()
    expect(sendInput).toHaveBeenNthCalledWith(
      1,
      "'/mnt/c/Users/alice/Desktop/notes one.txt' ",
      'driving'
    )
    expect(sendInput).toHaveBeenNthCalledWith(2, '/home/alice/repo/README.md ', 'driving')
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('pastes a spaced image from a Windows-path project forced to WSL with POSIX escaping', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: null }
    mocks.storeState.projects = [
      { id: 'repo1', localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }
    ]
    stubLocalRepo('C:\\Users\\alice\\repo')
    const sendInput = vi.fn(() => true)
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }

    await handleTerminalFileDrop({
      manager: { getActivePane: () => pane, getPanes: () => [pane] } as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      pane,
      paths: ['C:\\Users\\alice\\Desktop\\Screenshot 1.png']
    })

    // Why: the agent runs in Linux, so a Windows-style quote would reach it as a literal.
    expect(sendInput).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('/mnt/c/Users/alice/Desktop/Screenshot\\ 1.png'),
      'driving'
    )
  })

  it('uses acknowledged PTY writes for native local drops when available', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    stubLocalRepo('/repo')
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
      pane,
      paths: ['/Users/me/spec.pdf']
    })

    expect(sendInputAccepted).toHaveBeenCalledWith('/Users/me/spec.pdf ', 'driving', {
      signal: expect.any(AbortSignal)
    })
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('pastes native file drops into the pane captured by its element', async () => {
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    stubLocalRepo('/repo')
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
      pane: targetPane,
      paths: ['/Users/me/spec.pdf']
    })

    expect(activeSendInput).not.toHaveBeenCalled()
    expect(activeFocus).not.toHaveBeenCalled()
    expect(targetSendInput).toHaveBeenCalledWith('/Users/me/spec.pdf ', 'driving')
    expect(targetFocus).not.toHaveBeenCalled()
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
      pane,
      paths: [
        'C:\\Users\\Name\\My Project\\file.txt',
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo\\README.md'
      ]
    })

    expect(mocks.resolveDroppedPathsForAgent).toHaveBeenCalledWith({
      paths: [
        'C:\\Users\\Name\\My Project\\file.txt',
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo\\README.md'
      ],
      worktreePath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\repo'
    })
    expect(sendInput.mock.calls).toEqual([
      ["'/mnt/c/Users/Name/My Project/file.txt' ", 'driving'],
      ['/home/user/repo/README.md ', 'driving']
    ])
    expect(focus).not.toHaveBeenCalled()
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
      pane,
      paths: ['C:\\Users\\Name\\My Project\\file.txt']
    })

    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('uses SSH remote platform metadata for Windows remote path drops', async () => {
    stubSshRepo('ssh-win', 'C:\\Remote Repo', { remotePlatform: 'win32', connectionGeneration: 4 })
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
      pane,
      paths: ['C:\\Users\\Name\\A&B.txt']
    })

    expect(mocks.resolveDroppedPathsForAgent).toHaveBeenCalledWith({
      paths: ['C:\\Users\\Name\\A&B.txt'],
      worktreePath: 'C:\\Remote Repo',
      connectionId: 'ssh-win',
      expectedExecutionHostId: 'ssh:ssh-win',
      expectedSshTargetId: 'ssh-win',
      expectedSshConnectionGeneration: 4,
      uploadIds: expect.any(Object)
    })
    expect(sendInput).toHaveBeenCalledWith('"C:\\Remote Repo\\A&B.txt" ', 'driving')
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('pastes a spaced image dropped on a Windows SSH host with Windows quoting', async () => {
    stubSshRepo('ssh-win', 'C:\\Remote Repo', { remotePlatform: 'win32', connectionGeneration: 4 })
    mocks.resolveDroppedPathsForAgent.mockResolvedValue({
      failed: [],
      resolvedPaths: ['C:\\Remote Repo\\.orca\\drops\\Screenshot 1.png'],
      skipped: []
    })
    const sendInput = vi.fn(() => true)
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }

    await handleTerminalFileDrop({
      manager: { getActivePane: () => pane, getPanes: () => [pane] } as never,
      paneTransports: new Map([[1, createTerminalTransport(sendInput)]]) as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      pane,
      paths: ['/Users/me/Screenshot 1.png']
    })

    // Why: agents on Windows keep backslashes, so POSIX escaping would corrupt the path.
    expect(sendInput).toHaveBeenCalledWith(
      wrapTerminalBracketedPasteText('"C:\\Remote Repo\\.orca\\drops\\Screenshot 1.png"'),
      'driving'
    )
  })

  it('surfaces stale SSH owner capture failures without rejecting the native drop', async () => {
    stubSshRepo('ssh-stale', '/remote/repo', { remotePlatform: 'linux' })
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }

    await expect(
      handleTerminalFileDrop({
        manager: { getActivePane: () => pane, getPanes: () => [pane] } as never,
        paneTransports: new Map([[1, createTerminalTransport(vi.fn(() => true))]]) as never,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        cwd: undefined,
        pane,
        paths: ['/local/a.txt']
      })
    ).resolves.toBeUndefined()

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't verify the SSH connection. Reconnect the host and try again."
    )
    expect(mocks.resolveDroppedPathsForAgent).not.toHaveBeenCalled()
  })

  it('keeps SSH Linux path drops on POSIX shell escaping', async () => {
    stubSshRepo('ssh-linux', '/remote/repo', { remotePlatform: 'linux', connectionGeneration: 5 })
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
      pane,
      paths: ["/Users/me/it's here.txt"]
    })

    expect(sendInput).toHaveBeenCalledWith("'/remote/repo/it'\\''s here.txt' ", 'driving')
  })
})

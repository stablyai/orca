import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockGuardRoute = {
  target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
  connectionId: string | undefined
}

const {
  statUserOpenedPathMock,
  callRuntimeRpcMock,
  hostSavesGrantedFilesMock,
  openFileMock,
  scheduleEditorLineRevealMock,
  guardState
} = vi.hoisted(() => {
  const state: { route: MockGuardRoute } = {
    route: {
      target: { kind: 'local' },
      connectionId: undefined
    }
  }
  return {
    statUserOpenedPathMock: vi.fn(),
    callRuntimeRpcMock: vi.fn(),
    hostSavesGrantedFilesMock: vi.fn(),
    openFileMock: vi.fn(),
    scheduleEditorLineRevealMock: vi.fn(),
    guardState: state
  }
})

vi.mock('@/lib/files/access/user-opened-local-path', () => ({
  statUserOpenedPath: statUserOpenedPathMock
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: callRuntimeRpcMock
}))

vi.mock('@/runtime/files/grants/runtime-terminal-artifact-grant', () => ({
  hostSavesGrantedFiles: hostSavesGrantedFilesMock
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openFile: openFileMock,
      setMarkdownViewMode: vi.fn()
    })
  }
}))

vi.mock('@/store/slices/editor/focus/editor-focus-reveal', () => ({
  scheduleEditorLineReveal: scheduleEditorLineRevealMock
}))

vi.mock('../../right-sidebar/file-explorer/navigation/file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({}),
  captureFileExplorerOperationGuard: () => ({
    route: guardState.route,
    assertCurrent: () => {}
  })
}))

import { openQuickOpenFile } from './quick-open-file-navigation'

describe('openQuickOpenFile home-relative paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        platform: {
          get: () => ({ platform: 'darwin' })
        }
      }
    })
    guardState.route = { target: { kind: 'local' }, connectionId: undefined }
    openFileMock.mockReturnValue('file-1')
    hostSavesGrantedFilesMock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('expands a local ~/ path with :line via statUserOpenedPath resolvedPath and reveals the line', async () => {
    statUserOpenedPathMock.mockImplementation(async (_ctx: unknown, path: string) => {
      if (path === '~/.zshrc:12') {
        throw new Error('ENOENT: no such file or directory')
      }
      return {
        isDirectory: false,
        escapesWorktree: false,
        resolvedPath: '/Users/demo/.zshrc'
      }
    })

    await openQuickOpenFile(
      '~/.zshrc',
      'wt-1',
      '/Users/demo/code/repo',
      { pathQuery: '~/.zshrc', line: 12 },
      '~/.zshrc:12'
    )

    expect(statUserOpenedPathMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1', worktreePath: '/Users/demo/code/repo' }),
      '~/.zshrc'
    )
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/Users/demo/.zshrc',
        relativePath: '/Users/demo/.zshrc'
      })
    )
    expect(scheduleEditorLineRevealMock).toHaveBeenCalledWith(
      expect.any(Function),
      '/Users/demo/.zshrc',
      12,
      undefined,
      'file-1'
    )
  })

  it('prefers an existing literal ~/file:12 filename over line navigation', async () => {
    statUserOpenedPathMock.mockResolvedValue({
      isDirectory: false,
      escapesWorktree: false,
      resolvedPath: '/Users/demo/notes:12'
    })

    await openQuickOpenFile(
      '~/notes',
      'wt-1',
      '/Users/demo/code/repo',
      { pathQuery: '~/notes', line: 12 },
      '~/notes:12'
    )

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/Users/demo/notes:12',
        relativePath: '/Users/demo/notes:12'
      })
    )
    expect(scheduleEditorLineRevealMock).not.toHaveBeenCalled()
  })

  it('derives a worktree-relative path when a local ~/ path resolves inside the active worktree', async () => {
    statUserOpenedPathMock.mockResolvedValue({
      isDirectory: false,
      escapesWorktree: false,
      resolvedPath: '/Users/demo/code/repo/src/index.ts'
    })

    await openQuickOpenFile(
      '~/code/repo/src/index.ts',
      'wt-1',
      '/Users/demo/code/repo',
      { pathQuery: '~/code/repo/src/index.ts' },
      '~/code/repo/src/index.ts'
    )

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/Users/demo/code/repo/src/index.ts',
        relativePath: 'src/index.ts'
      })
    )
  })

  it('refuses ~/ paths for local WSL workspaces instead of expanding with the Windows home', async () => {
    await expect(
      openQuickOpenFile(
        '~/.bashrc',
        'wt-wsl',
        '\\\\wsl.localhost\\Ubuntu\\home\\demo\\repo',
        { pathQuery: '~/.bashrc' },
        '~/.bashrc'
      )
    ).rejects.toThrow(/cannot be expanded/i)
    expect(statUserOpenedPathMock).not.toHaveBeenCalled()
  })

  it('refuses ~/ paths for direct SSH workspaces instead of expanding with the local home', async () => {
    guardState.route = { target: { kind: 'local' }, connectionId: 'ssh-host-1' }
    await expect(
      openQuickOpenFile(
        '~/.zshrc',
        'wt-ssh',
        '/home/remote/repo',
        { pathQuery: '~/.zshrc' },
        '~/.zshrc'
      )
    ).rejects.toThrow(/cannot be expanded/i)
    expect(statUserOpenedPathMock).not.toHaveBeenCalled()
  })

  it('delegates ~/ paths on paired remote runtimes to files.resolveTerminalPath', async () => {
    guardState.route = {
      target: { kind: 'environment', environmentId: 'env-1' },
      connectionId: undefined
    }
    callRuntimeRpcMock.mockResolvedValue({
      worktree: 'wt-remote',
      exists: true,
      isDirectory: false,
      absolutePath: '/home/remote/.zshrc',
      relativePath: null,
      openTarget: {
        kind: 'absolute-file',
        grantId: 'grant-1',
        absolutePath: '/home/remote/.zshrc',
        readOnly: false
      }
    })

    await openQuickOpenFile(
      '~/.zshrc',
      'wt-remote',
      '/home/remote/repo',
      { pathQuery: '~/.zshrc' },
      '~/.zshrc'
    )

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'files.resolveTerminalPath',
      expect.objectContaining({ pathText: '~/.zshrc' })
    )
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/remote/.zshrc',
        relativePath: '/home/remote/.zshrc',
        terminalArtifactGrantId: 'grant-1'
      })
    )
  })
})

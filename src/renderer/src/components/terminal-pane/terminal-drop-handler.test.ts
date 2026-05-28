import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastLoading: vi.fn(() => 'toast-1'),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  importExternalPathsToRuntime: vi.fn(),
  storeState: {
    settings: { activeRuntimeEnvironmentId: 'env-1' as string | null },
    worktreesByRepo: {
      repo1: [{ id: 'wt-1', path: '/remote/repo' }]
    }
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

import { handleTerminalFileDrop, resolveTerminalDropTargetShell } from './terminal-drop-handler'

describe('handleTerminalFileDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', path: '/remote/repo' }]
    }
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
    const sendInput = vi.fn()
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, terminal: { focus } }),
      getPanes: () => []
    }
    const paneTransports = new Map([[1, { sendInput }]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      cwd: undefined,
      data: { paths: ['/Users/me/logo.png'], target: 'terminal' }
    })

    expect(mocks.importExternalPathsToRuntime).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      ['/Users/me/logo.png'],
      '/remote/repo/.orca/drops'
    )
    expect(sendInput).toHaveBeenCalledWith('/remote/repo/.orca/drops/logo.png ')
    expect(focus).toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('uses Windows shell paths for forward-slash UNC runtime worktrees', async () => {
    mocks.storeState.worktreesByRepo = {
      repo1: [{ id: 'wt-1', path: '//server/share/repo' }]
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
    const sendInput = vi.fn()
    const focus = vi.fn()
    const manager = {
      getActivePane: () => ({ id: 1, terminal: { focus } }),
      getPanes: () => []
    }
    const paneTransports = new Map([[1, { sendInput }]])

    await handleTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      cwd: undefined,
      data: { paths: ['/Users/me/logo.png'], target: 'terminal' }
    })

    expect(mocks.importExternalPathsToRuntime).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '//server/share/repo'
      },
      ['/Users/me/logo.png'],
      '\\\\server\\share\\repo\\.orca\\drops'
    )
    expect(sendInput).toHaveBeenCalledWith('\\\\server\\share\\repo\\.orca\\drops\\logo.png ')
  })
})

describe('resolveTerminalDropTargetShell', () => {
  it('uses runtime worktree path shape for active Windows runtimes', () => {
    expect(
      resolveTerminalDropTargetShell({
        activeRuntimeEnvironmentId: 'env-1',
        worktreePath: '//Server/Share/Repo',
        connectionId: null,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      })
    ).toBe('windows')
  })

  it('uses runtime worktree path shape for active POSIX runtimes', () => {
    expect(
      resolveTerminalDropTargetShell({
        activeRuntimeEnvironmentId: 'env-1',
        worktreePath: '/home/orca/repo',
        connectionId: null,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      })
    ).toBe('posix')
  })

  it('keeps legacy SSH drops POSIX when no runtime environment is active', () => {
    expect(
      resolveTerminalDropTargetShell({
        activeRuntimeEnvironmentId: null,
        worktreePath: 'C:\\repo',
        connectionId: 'ssh-1',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      })
    ).toBe('posix')
  })
})

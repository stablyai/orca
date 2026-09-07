import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'
import { getConnectionId } from '@/lib/connection-context'
import { getWorkspaceFilePreviewPlan, openFileInBrowserTab } from '@/lib/file-preview'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  deps,
  authorizeExternalPathMock,
  statMock,
  openFileMock,
  openFilePathMock,
  createBrowserTabMock,
  runtimeEnvironmentCallMock
} = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('./terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: vi.fn()
}))

vi.mock('@/lib/file-preview', () => ({
  getWorkspaceFilePreviewPlan: vi.fn(() => ({ status: 'doc-preview' })),
  openFileInBrowserTab: vi.fn()
}))

installTerminalLinkTestEnvironment(doubles)

describe('handleOscLink', () => {
  it('stats remote-runtime file links through the active runtime environment', async () => {
    setPlatform('Macintosh')
    storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: { size: 1, isDirectory: false, mtime: 1 },
      _meta: { runtimeId: 'remote-runtime' }
    })

    openDetectedFilePath('/tmp/src/main.ts', null, null, deps)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.stat',
        params: { worktree: 'id:wt-1', relativePath: 'src/main.ts' },
        timeoutMs: 15_000
      })
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/src/main.ts',
        relativePath: 'src/main.ts'
      }),
      { forceContentReload: true }
    )
  })

  it('stats remote-runtime file links through the owning PTY runtime environment', async () => {
    setPlatform('Macintosh')
    storeState.settings = { activeRuntimeEnvironmentId: 'env-2' }
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: { size: 1, isDirectory: false, mtime: 1 },
      _meta: { runtimeId: 'remote-runtime' }
    })

    openDetectedFilePath('/tmp/src/main.ts', null, null, {
      ...deps,
      runtimeEnvironmentId: 'env-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.stat',
        params: { worktree: 'id:wt-1', relativePath: 'src/main.ts' },
        timeoutMs: 15_000
      })
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/src/main.ts',
        relativePath: 'src/main.ts',
        runtimeEnvironmentId: 'env-1'
      }),
      { forceContentReload: true }
    )
  })

  it('opens SSH file links through Orca without local authorization', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/home/me/repo/src/main.ts', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).toHaveBeenCalledWith({
      filePath: '/home/me/repo/src/main.ts',
      connectionId: 'ssh-1'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/me/repo/src/main.ts',
        relativePath: 'src/main.ts'
      }),
      { forceContentReload: true }
    )
  })

  it('keeps WSL-looking paths literal for a direct SSH pane', async () => {
    setPlatform('Windows')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    const literalPath = '//wsl.localhost/Ubuntu/repo/file.ts'

    openDetectedFilePath(literalPath, null, null, {
      worktreeId: 'wt-1',
      worktreePath: '//wsl.localhost/Ubuntu/repo',
      wslDistro: null
    })
    await flushAsyncWork()

    expect(statMock).toHaveBeenCalledWith({ filePath: literalPath, connectionId: 'ssh-1' })
    expect(openFileMock).toHaveBeenCalledWith(expect.objectContaining({ filePath: literalPath }), {
      forceContentReload: true
    })
  })

  it('pins SSH links outside the worktree to their target host', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/tmp/ssh-preview.png', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo'
    })
    await flushAsyncWork()

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).toHaveBeenCalledWith({
      filePath: '/tmp/ssh-preview.png',
      connectionId: 'ssh-1'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/ssh-preview.png',
        relativePath: '/tmp/ssh-preview.png',
        externalSshTargetId: 'ssh-1'
      }),
      { forceContentReload: true }
    )
  })

  it('does not pin runtime-owned links to the worktree SSH target', async () => {
    setPlatform('Windows')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: { size: 1, isDirectory: false, mtime: 1 },
      _meta: { runtimeId: 'remote-runtime' }
    })

    openDetectedFilePath('//wsl.localhost/ubuntu/home/Alice/repo/src/main.ts', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '//wsl$/Ubuntu/home/Alice/repo',
      runtimeEnvironmentId: 'env-1'
    })
    await flushAsyncWork()

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '//wsl.localhost/ubuntu/home/Alice/repo/src/main.ts'
      }),
      { forceContentReload: true }
    )
    expect(openFileMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ externalSshTargetId: expect.anything() }),
      { forceContentReload: true }
    )
  })

  it('downloads shift-modifier SSH file links before the OS opens them, like the popover row', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/home/me/repo/report.html', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo',
      openWithSystemDefault: true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(downloadAndOpenRemoteTerminalFile).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' }),
      '/home/me/repo/report.html'
    )
  })

  it('renders plain-modifier SSH html links in the doc preview, not a client-local browser tab', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/home/me/repo/report.html', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(openFileInBrowserTab).toHaveBeenCalledWith({
      filePath: '/home/me/repo/report.html',
      worktreeId: 'wt-1'
    })
    // Why: the preview tab is the surface — activation must not re-seed a shell into a
    // workspace whose last terminal the user closed.
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true
    })
  })

  it('falls back to the source editor when the preview plan is unsupported', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    vi.mocked(getWorkspaceFilePreviewPlan).mockReturnValueOnce({
      status: 'unsupported',
      message: 'nope',
      reason: 'outside-worktree'
    })

    openDetectedFilePath('/home/me/repo/report.html', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(openFileInBrowserTab).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/me/repo/report.html',
        relativePath: 'report.html'
      }),
      { forceContentReload: true }
    )
  })

  it('does not ask the client OS to open SSH directories', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    statMock.mockResolvedValueOnce({ isDirectory: true })

    openDetectedFilePath('/home/me/repo/src', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
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

installTerminalLinkTestEnvironment(doubles)

const serverWorkspace = {
  worktreeId: 'wt-feat',
  worktreePath: '/srv/repo',
  runtimeEnvironmentId: 'env-1'
}

function hostDisowns(path: string): void {
  runtimeEnvironmentCallMock.mockResolvedValueOnce({
    id: 'rpc-1',
    ok: true,
    result: {
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: path,
      exists: false,
      isDirectory: false
    },
    _meta: { runtimeId: 'remote-runtime' }
  })
}

describe('a link to this computer printed in a paired-server terminal', () => {
  it('opens the clicked file from this computer, read-only in the server workspace', async () => {
    hostDisowns('/Users/me/notes.md')

    openDetectedFilePath('/Users/me/notes.md', 4, null, serverWorkspace)
    await flushDoubleRaf()

    expect(statMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/Users/me/notes.md',
        access: { kind: 'user-file' }
      })
    )
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/Users/me/notes.md',
        relativePath: '/Users/me/notes.md',
        worktreeId: 'wt-feat',
        runtimeEnvironmentId: null,
        readOnly: true
      }),
      { forceContentReload: true }
    )
  })

  it('opens a Shift-clicked file with this computer’s default app, not a download', async () => {
    hostDisowns('/Users/me/report.pdf')

    openDetectedFilePath('/Users/me/report.pdf', null, null, {
      ...serverWorkspace,
      openWithSystemDefault: true
    })
    await flushDoubleRaf()

    expect(openFilePathMock).toHaveBeenCalledWith('/Users/me/report.pdf', 'local')
    expect(downloadAndOpenRemoteTerminalFile).not.toHaveBeenCalled()
  })

  it('renders a clicked HTML file in a browser tab this computer owns', async () => {
    hostDisowns('/Users/me/Desktop/review.html')

    openDetectedFilePath('/Users/me/Desktop/review.html', null, null, serverWorkspace)
    await flushDoubleRaf()

    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-feat',
      'file:///Users/me/Desktop/review.html',
      expect.objectContaining({ browserRuntimeEnvironmentId: null })
    )
  })

  it('keeps the host refusal when this computer does not have the file either', async () => {
    hostDisowns('/etc/orca-missing')
    statMock.mockRejectedValueOnce(new Error('ENOENT: no such file'))
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/etc/orca-missing', null, null, {
      ...serverWorkspace,
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith({
      verdict: 'unverifiable',
      error: new Error('/etc/orca-missing is outside every workspace on its host')
    })
  })

  it('never reads this computer when the host cannot be reached', async () => {
    runtimeEnvironmentCallMock.mockRejectedValueOnce(new Error('socket closed'))
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/Users/me/notes.md', null, null, {
      ...serverWorkspace,
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unverifiable' }))
  })

  it('never reads this computer for a path the host granted as its own', async () => {
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-feat',
        relativePath: null,
        absolutePath: '/tmp/artifact.txt',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: '/tmp/artifact.txt',
          grantId: 'g-1'
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/tmp/artifact.txt', null, null, {
      ...serverWorkspace,
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalled()
  })
})

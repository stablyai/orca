import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY } from '../../../../shared/runtime-file-contracts'
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
  runtimeEnvironmentCallMock,
  runtimeEnvironmentTransportCallMock
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

  it('keeps the refusal from a host that cannot search its other workspaces', async () => {
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) => {
        const status = createCompatibleRuntimeStatusResponseIfNeeded(args)
        if (!status?.ok) {
          return runtimeEnvironmentCallMock(args)
        }
        const capabilities = status.result.capabilities?.filter(
          (capability) => capability !== TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY
        )
        return { ...status, result: { ...status.result, capabilities } }
      }
    )
    hostDisowns('/srv/other-project/config.json')
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/srv/other-project/config.json', null, null, {
      ...serverWorkspace,
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unverifiable' }))
  })

  it('never treats a paired web client filesystem as this computer', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    hostDisowns('/Users/me/notes.md')
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/Users/me/notes.md', null, null, { ...serverWorkspace, onOpenFailure })
    await flushDoubleRaf()

    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unverifiable' }))
  })

  it('opens a path the host granted read-only from the host, never from this computer', async () => {
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
      terminalHandle: 'term-1',
      openWithSystemDefault: true,
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.resolveTerminalPath',
        params: {
          worktree: 'id:wt-feat',
          pathText: '/tmp/artifact.txt',
          crossWorkspace: true,
          terminal: 'term-1'
        }
      })
    )
    expect(statMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(downloadAndOpenRemoteTerminalFile).not.toHaveBeenCalled()
    expect(onOpenFailure).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/artifact.txt',
        relativePath: '/tmp/artifact.txt',
        worktreeId: 'wt-feat',
        runtimeEnvironmentId: 'env-1',
        readOnly: true,
        terminalArtifactGrantId: 'g-1'
      }),
      { forceContentReload: true }
    )
  })

  it('never reads this computer for a host directory outside its workspaces', async () => {
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-feat',
        relativePath: null,
        absolutePath: '/tmp/out',
        exists: true,
        isDirectory: true
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/tmp/out', null, null, { ...serverWorkspace, onOpenFailure })
    await flushDoubleRaf()

    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { buildFileLinkActions } from './terminal-file-link-actions'
import { downloadRemoteTerminalFile } from './terminal-remote-file-download-open'
import { openDetectedFolder } from './terminal-folder-open'
import type * as ArtifactGrantModule from '@/runtime/files/grants/runtime-terminal-artifact-grant'
import { createTerminalLinkTestDoubles } from '../terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from '../terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock, openFilePathMock, statMock } = doubles
const downloadFileMock = vi.fn()
const downloadFolderMock = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('./terminal-folder-open', () => ({ openDetectedFolder: vi.fn() }))

vi.mock('@/runtime/files/grants/runtime-terminal-artifact-grant', async (importOriginal) => ({
  ...(await importOriginal<typeof ArtifactGrantModule>()),
  hostStreamsGrantedFiles: vi.fn(async () => false)
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

beforeEach(() => {
  setPlatform('Windows')
  vi.mocked(getConnectionId).mockReturnValue('box')
  storeState.worktreesByRepo = {
    repo1: [{ id: 'wt-1', path: '/home/me/repo', repoId: 'repo1', hostId: 'ssh:box' }]
  }
  downloadFileMock.mockResolvedValue({ canceled: false, destinationPath: 'C:\\Users\\me\\run.sh' })
  downloadFolderMock.mockResolvedValue({ canceled: false, destinationPath: 'C:\\Users\\me\\out' })
  Object.assign(window.api.fs, {
    downloadFile: downloadFileMock,
    downloadFolder: downloadFolderMock
  })
  Object.assign(storeState, { sshConnectionStates: new Map() })
  Object.assign(window.api, { platform: { get: () => ({ platform: 'win32' }) } })
})

describe('remote file link download action', () => {
  it('saves an SSH file without opening it', async () => {
    const actions = buildFileLinkActions(
      '/home/me/repo/run.sh',
      null,
      null,
      { worktreeId: 'wt-1', worktreePath: '/home/me/repo', runtimeEnvironmentId: null },
      { kind: 'ssh', connectionId: 'box' }
    )
    const download = actions.secondaryActions?.find((row) => row.label === 'Download…')

    expect(download).toBeDefined()
    await download?.run()
    await flushAsyncWork()

    expect(downloadFileMock).toHaveBeenCalledWith({
      filePath: '/home/me/repo/run.sh',
      connectionId: 'box'
    })
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it.each([
    [true, 1, 'success'],
    [false, 0, 'error']
  ] as const)(
    'with folder transfer %s, saves or reports a folder link instead of revealing it',
    async (supportsFolderDownload, downloads, toastKind) => {
      statMock.mockResolvedValue({ isDirectory: true })
      Object.assign(storeState, {
        sshConnectionStates: new Map([['box', { supportsFolderDownload }]])
      })
      const actions = buildFileLinkActions(
        '/home/me/repo/out',
        null,
        null,
        { worktreeId: 'wt-1', worktreePath: '/home/me/repo', runtimeEnvironmentId: null },
        { kind: 'ssh', connectionId: 'box' }
      )
      const download = actions.secondaryActions?.find((row) => row.label === 'Download…')

      expect(download).toBeDefined()
      await download?.run()
      await flushAsyncWork()

      expect(downloadFolderMock).toHaveBeenCalledTimes(downloads)
      expect(toast[toastKind]).toHaveBeenCalledTimes(1)
      expect(openDetectedFolder).not.toHaveBeenCalled()
      expect(downloadFileMock).not.toHaveBeenCalled()
    }
  )

  it('reports a path the host disowned that is on this computer instead of opening it', async () => {
    await downloadRemoteTerminalFile(
      { target: { kind: 'local' }, worktreeId: 'wt-1', worktreePath: '/home/me/repo' },
      '/home/me/repo/run.sh',
      null
    )

    expect(toast.info).toHaveBeenCalledTimes(1)
    expect(downloadFileMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('tells the user to update a paired server that cannot stream a granted file', async () => {
    await downloadRemoteTerminalFile(
      {
        target: { kind: 'environment', environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/home/me/repo'
      },
      '/tmp/run.sh',
      { terminalArtifactGrantId: 'g1' }
    )

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('newer Orca server'))
    expect(openFilePathMock).not.toHaveBeenCalled()
  })
})

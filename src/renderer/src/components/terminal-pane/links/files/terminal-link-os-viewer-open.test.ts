import { describe, expect, it, vi } from 'vitest'
import './terminal-link-handlers'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { getConnectionId } from '@/lib/connection-context'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { createTerminalLinkTestDoubles } from '../terminal-link-handlers-test-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from '../terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, deps, openFileMock, openFilePathMock, runtimeEnvironmentCallMock } = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('./terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: vi.fn(async () => true)
}))

installTerminalLinkTestEnvironment(doubles)

const sshDeps = { worktreeId: 'wt-1', worktreePath: '/home/me/repo' }

describe('a plain click on a local binary the editor cannot display', () => {
  it('opens it with the system default app', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/media/clip.mp4', null, null, deps)
    await flushAsyncWork()

    expect(openFilePathMock).toHaveBeenCalledTimes(1)
    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/media/clip.mp4', 'local')
    expect(openFileMock).not.toHaveBeenCalled()
    expect(activateAndRevealWorkspace).not.toHaveBeenCalled()
  })

  it('falls back to the editor when the OS has no app for it', async () => {
    setPlatform('Macintosh')
    openFilePathMock.mockResolvedValueOnce(false)

    openDetectedFilePath('/tmp/dist/assets.7z', null, null, deps)
    await flushAsyncWork()

    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/dist/assets.7z', 'local')
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/dist/assets.7z' }),
      { forceContentReload: true }
    )
  })

  it('does not fall back to the editor once a newer click superseded it', async () => {
    setPlatform('Macintosh')
    const firstOpen = createDeferred<boolean>()
    openFilePathMock.mockImplementationOnce(() => firstOpen.promise)

    openDetectedFilePath('/tmp/media/first.mov', null, null, deps)
    await flushAsyncWork()
    openDetectedFilePath('/tmp/src/second.ts', null, null, deps)
    await flushAsyncWork()
    firstOpen.resolve(false)
    await flushAsyncWork()

    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/src/second.ts' }),
      { forceContentReload: true }
    )
  })

  it('never hands executables or loadable code to the OS', async () => {
    setPlatform('Macintosh')

    for (const filePath of ['/tmp/bin/tool.exe', '/tmp/bin/app.jar', '/tmp/bin/lib.dylib']) {
      openDetectedFilePath(filePath, null, null, deps)
      await flushAsyncWork()
    }

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledTimes(3)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/bin/tool.exe' }),
      { forceContentReload: true }
    )
  })

  it('keeps images and PDFs in the editor viewers', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/docs/shot.png', null, null, deps)
    await flushAsyncWork()
    openDetectedFilePath('/tmp/docs/spec.pdf', null, null, deps)
    await flushAsyncWork()

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/docs/shot.png' }),
      { forceContentReload: true }
    )
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/docs/spec.pdf' }),
      { forceContentReload: true }
    )
  })
})

describe('a plain click on a remote binary the editor cannot display', () => {
  it('downloads an SSH binary, then opens it', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/home/me/repo/renders/clip.mp4', null, null, sshDeps)
    await flushAsyncWork()

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(downloadAndOpenRemoteTerminalFile).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' }),
      '/home/me/repo/renders/clip.mp4',
      expect.objectContaining({ grant: null, isCurrent: expect.any(Function) })
    )
  })

  it('marks an SSH binary download stale once a newer click starts', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/home/me/repo/renders/clip.mp4', null, null, sshDeps)
    await flushAsyncWork()
    const isRequestCurrent = vi.mocked(downloadAndOpenRemoteTerminalFile).mock.calls[0]?.[2]
      ?.isCurrent
    expect(isRequestCurrent?.()).toBe(true)

    openDetectedFilePath('/home/me/repo/src/main.ts', null, null, sshDeps)
    expect(isRequestCurrent?.()).toBe(false)
  })

  it('keeps SSH images in the editor viewer', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/home/me/repo/renders/frame.png', null, null, sshDeps)
    await flushAsyncWork()

    expect(downloadAndOpenRemoteTerminalFile).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/home/me/repo/renders/frame.png' }),
      { forceContentReload: true }
    )
  })

  it('downloads a granted archive through its grant, or opens it in Orca when its host cannot page it', async () => {
    const archive = '/srv/out/build.zip'
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-main',
        relativePath: null,
        absolutePath: archive,
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: archive,
          grantId: 'g-1'
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    vi.mocked(downloadAndOpenRemoteTerminalFile).mockResolvedValueOnce(false)

    openDetectedFilePath(archive, null, null, {
      worktreeId: 'wt-feat',
      worktreePath: '/repo/.orca/worktrees/feat-x',
      runtimeEnvironmentId: 'env-1'
    })
    await flushDoubleRaf()

    expect(downloadAndOpenRemoteTerminalFile).toHaveBeenCalledWith(
      expect.anything(),
      archive,
      expect.objectContaining({
        grant: expect.objectContaining({ terminalArtifactGrantId: 'g-1' })
      })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: archive, terminalArtifactGrantId: 'g-1' }),
      { forceContentReload: true }
    )
  })
})

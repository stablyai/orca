import { describe, expect, it, vi } from 'vitest'
import { createTerminalLinkTestDoubles } from '../terminal-link-handlers-test-fixtures'
import './terminal-link-handlers'
import { openDetectedFilePath } from './terminal-file-open-routing'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { TERMINAL_ARTIFACT_CHUNK_RUNTIME_CAPABILITY } from '../../../../../../shared/files-runtime-capabilities'
import { installTerminalLinkTestEnvironment } from '../terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  openFileMock,
  runtimeEnvironmentCallMock,
  runtimeEnvironmentTransportCallMock
} = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('a Shift-clicked paired-server file outside its workspace', () => {
  function shiftClickGrantedVideo(): string {
    const video = '/tmp/teste.mp4'
    runtimeEnvironmentCallMock.mockImplementation(async ({ method }: { method: string }) => ({
      id: 'rpc-1',
      ok: true,
      result:
        method === 'files.readTerminalArtifactChunk'
          ? { contentBase64: 'AAEC', bytesRead: 3, eof: true }
          : {
              worktree: 'wt-1',
              relativePath: null,
              absolutePath: video,
              exists: true,
              isDirectory: false,
              openTarget: {
                kind: 'absolute-file',
                provider: 'local',
                absolutePath: video,
                grantId: 'g-1'
              }
            },
      _meta: { runtimeId: 'remote-runtime' }
    }))
    Object.assign(window.api.fs, {
      startDownloadedFile: vi.fn().mockResolvedValue({ canceled: false, transferId: 't-1' }),
      appendDownloadedFileChunk: vi.fn().mockResolvedValue(undefined),
      finishDownloadedFile: vi
        .fn()
        .mockResolvedValue({ canceled: false, destinationPath: '/Downloads/teste.mp4' }),
      cancelDownloadedFile: vi.fn().mockResolvedValue(undefined)
    })
    openDetectedFilePath(video, null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/srv/repo',
      runtimeEnvironmentId: 'env-1',
      openWithSystemDefault: true
    })
    return video
  }

  // Why: a grant's whole-file text read refuses binaries and caps size, so downloads page it instead.
  it('downloads a granted binary in pages through its grant', async () => {
    const video = shiftClickGrantedVideo()

    await vi.waitFor(() =>
      expect(window.api.shell.openFilePath).toHaveBeenCalledWith('/Downloads/teste.mp4', 'local')
    )
    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.readTerminalArtifactChunk',
        params: expect.objectContaining({ grantId: 'g-1', absolutePath: video, offset: 0 })
      })
    )
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('opens a granted file in Orca when its host cannot page grants', async () => {
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) => {
        const status = createCompatibleRuntimeStatusResponseIfNeeded(args)
        if (!status?.ok) {
          return runtimeEnvironmentCallMock(args)
        }
        const capabilities = status.result.capabilities?.filter(
          (capability) => capability !== TERMINAL_ARTIFACT_CHUNK_RUNTIME_CAPABILITY
        )
        return { ...status, result: { ...status.result, capabilities } }
      }
    )
    const video = shiftClickGrantedVideo()

    await vi.waitFor(() =>
      expect(openFileMock).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: video, terminalArtifactGrantId: 'g-1' }),
        { forceContentReload: true }
      )
    )
    expect(window.api.fs.startDownloadedFile).not.toHaveBeenCalled()
  })
})

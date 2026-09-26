import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/runtime-file-client', () => ({ downloadRuntimeFile: vi.fn() }))

const downloadFileMock = vi.fn()
const openFilePathMock = vi.fn()

beforeEach(() => {
  downloadFileMock.mockResolvedValue({ canceled: false, destinationPath: '/local/clip.mp4' })
  vi.stubGlobal('window', {
    api: { fs: { downloadFile: downloadFileMock }, shell: { openFilePath: openFilePathMock } }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('downloadAndOpenRemoteTerminalFile', () => {
  const fileContext = {
    settings: null,
    worktreeId: 'wt-1',
    worktreePath: '/home/me',
    connectionId: 'ssh-1'
  }

  it('opens the downloaded copy while the request is current', async () => {
    await downloadAndOpenRemoteTerminalFile(fileContext, '/home/me/clip.mp4', () => true)

    expect(openFilePathMock).toHaveBeenCalledWith('/local/clip.mp4')
  })

  it('does not open the downloaded copy once a newer request superseded it', async () => {
    await downloadAndOpenRemoteTerminalFile(fileContext, '/home/me/clip.mp4', () => false)

    expect(downloadFileMock).toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens the downloaded copy when the caller does not track freshness', async () => {
    await downloadAndOpenRemoteTerminalFile(fileContext, '/home/me/clip.mp4')

    expect(openFilePathMock).toHaveBeenCalledWith('/local/clip.mp4')
  })
})

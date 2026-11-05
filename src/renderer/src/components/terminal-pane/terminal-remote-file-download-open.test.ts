import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/runtime-file-read-client', () => ({ downloadRuntimeFile: vi.fn() }))

const downloadFileMock = vi.fn()
const openFilePathMock = vi.fn()

beforeEach(() => {
  downloadFileMock.mockResolvedValue({ canceled: false, destinationPath: '/local/clip.mp4' })
  openFilePathMock.mockResolvedValue(true)
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
    target: { kind: 'local' as const },
    worktreeId: 'wt-1',
    worktreePath: '/home/me',
    connectionId: 'ssh-1'
  }

  it('opens the downloaded copy while the request is current', async () => {
    await downloadAndOpenRemoteTerminalFile(fileContext, '/home/me/clip.mp4', () => true)

    expect(openFilePathMock).toHaveBeenCalledWith('/local/clip.mp4', 'local')
  })

  it('does not open the downloaded copy once a newer request superseded it', async () => {
    await downloadAndOpenRemoteTerminalFile(fileContext, '/home/me/clip.mp4', () => false)

    expect(downloadFileMock).toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens the downloaded copy when the caller does not track freshness', async () => {
    await downloadAndOpenRemoteTerminalFile(fileContext, '/home/me/clip.mp4')

    expect(openFilePathMock).toHaveBeenCalledWith('/local/clip.mp4', 'local')
  })

  it('says where the copy was saved when no app opens it', async () => {
    openFilePathMock.mockResolvedValue(false)

    await downloadAndOpenRemoteTerminalFile(fileContext, '/home/me/clip.mp4', () => true)

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('/local/clip.mp4'))
  })

  it('stays quiet when an app opens the copy', async () => {
    await downloadAndOpenRemoteTerminalFile(fileContext, '/home/me/clip.mp4', () => true)

    expect(toast.error).not.toHaveBeenCalled()
  })
})

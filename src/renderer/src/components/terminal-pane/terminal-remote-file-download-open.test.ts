import { describe, expect, it, vi } from 'vitest'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import {
  fsDownloadFile,
  fsStartDownloadedFile,
  fsAppendDownloadedFileChunk,
  fsFinishDownloadedFile,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from '@/runtime/runtime-file-client-test-harness'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

installRuntimeFileClientEnvironment()

describe('remote terminal download and open', () => {
  it('downloads nested SSH content through the owning runtime before opening the local result', async () => {
    const openFilePath = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.api, 'shell', { value: { openFilePath }, configurable: true })
    fsStartDownloadedFile.mockResolvedValue({
      canceled: false,
      transferId: 'download-1',
      destinationPath: '/downloads/report.txt'
    })
    fsAppendDownloadedFileChunk.mockResolvedValue({ ok: true })
    fsFinishDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/report.txt'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'read',
      ok: true,
      result: { contentBase64: 'cmVtb3Rl', bytesRead: 6, eof: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
    await downloadAndOpenRemoteTerminalFile(
      {
        settings: { activeRuntimeEnvironmentId: 'hub-a' },
        worktreeId: 'repo::/remote/repo',
        worktreePath: '/remote/repo',
        connectionId: 'ssh-1'
      },
      '/remote/repo/report.txt'
    )
    expect(fsDownloadFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'hub-a', method: 'files.readChunk' })
    )
    expect(fsAppendDownloadedFileChunk).toHaveBeenCalledWith({
      transferId: 'download-1',
      contentBase64: 'cmVtb3Rl'
    })
    expect(openFilePath).toHaveBeenCalledWith('/downloads/report.txt')
  })

  it('keeps direct SSH downloads on the desktop SSH provider', async () => {
    const openFilePath = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.api, 'shell', { value: { openFilePath }, configurable: true })
    fsDownloadFile.mockResolvedValue({ canceled: false, destinationPath: '/downloads/report.txt' })
    await downloadAndOpenRemoteTerminalFile(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'repo::/remote/repo',
        worktreePath: '/remote/repo',
        connectionId: 'ssh-1'
      },
      '/remote/repo/report.txt'
    )
    expect(fsDownloadFile).toHaveBeenCalledWith({
      filePath: '/remote/repo/report.txt',
      connectionId: 'ssh-1'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(openFilePath).toHaveBeenCalledWith('/downloads/report.txt')
  })

  it('does not open a file when a nested SSH save is canceled', async () => {
    const openFilePath = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.api, 'shell', { value: { openFilePath }, configurable: true })
    fsStartDownloadedFile.mockResolvedValue({ canceled: true })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'read',
      ok: true,
      result: { contentBase64: 'cmVtb3Rl', bytesRead: 6, eof: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
    await downloadAndOpenRemoteTerminalFile(
      {
        settings: { activeRuntimeEnvironmentId: 'hub-a' },
        worktreeId: 'repo::/remote/repo',
        worktreePath: '/remote/repo',
        connectionId: 'ssh-1'
      },
      '/remote/repo/report.txt'
    )
    expect(fsDownloadFile).not.toHaveBeenCalled()
    expect(fsAppendDownloadedFileChunk).not.toHaveBeenCalled()
    expect(openFilePath).not.toHaveBeenCalled()
  })
})

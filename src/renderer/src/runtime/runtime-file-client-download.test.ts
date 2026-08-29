import { describe, expect, it } from 'vitest'
import { downloadRuntimeFile } from './runtime-file-client'
import {
  fsSaveDownloadedFile,
  fsStartDownloadedFile,
  fsAppendDownloadedFileChunk,
  fsFinishDownloadedFile,
  fsCancelDownloadedFile,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('downloads remote runtime files in chunks instead of using preview content', async () => {
    fsStartDownloadedFile.mockResolvedValue({
      canceled: false,
      transferId: 'download-1',
      destinationPath: '/downloads/archive.zip'
    })
    fsAppendDownloadedFileChunk.mockResolvedValue({ ok: true })
    fsFinishDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/archive.zip'
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'preflight',
        ok: true,
        result: { contentBase64: 'YWJj', bytesRead: 3, eof: false },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: true,
        result: { contentBase64: 'YWJj', bytesRead: 3, eof: false },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'chunk-2',
        ok: true,
        result: { contentBase64: 'ZA==', bytesRead: 1, eof: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/archive.zip',
        'archive.zip'
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/archive.zip' })

    expect(fsStartDownloadedFile).toHaveBeenCalledWith({ suggestedName: 'archive.zip' })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'files.readChunk',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'archive.zip',
        offset: 0,
        length: 1
      },
      timeoutMs: 60_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.readChunk',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'archive.zip',
        offset: 0,
        length: 384 * 1024
      },
      timeoutMs: 60_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'files.readChunk',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'archive.zip',
        offset: 3,
        length: 384 * 1024
      },
      timeoutMs: 60_000
    })
    expect(fsAppendDownloadedFileChunk).toHaveBeenCalledTimes(2)
    expect(fsFinishDownloadedFile).toHaveBeenCalledWith({ transferId: 'download-1' })
    expect(fsCancelDownloadedFile).not.toHaveBeenCalled()
  })

  it('does not open the save dialog when the remote chunk probe fails for transport reasons', async () => {
    runtimeEnvironmentCall.mockRejectedValueOnce(new Error('connection dropped'))

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/archive.zip',
        'archive.zip'
      )
    ).rejects.toThrow('connection dropped')

    expect(fsStartDownloadedFile).not.toHaveBeenCalled()
    expect(fsSaveDownloadedFile).not.toHaveBeenCalled()
  })

  it('falls back to preview content when older remote runtimes lack chunked download', async () => {
    fsSaveDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/report.txt'
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method: files.readChunk'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'preview-1',
        ok: true,
        result: { content: 'hello\n', isBinary: false },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/report.txt',
        'report.txt'
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/report.txt' })

    expect(fsStartDownloadedFile).not.toHaveBeenCalled()
    expect(fsSaveDownloadedFile).toHaveBeenCalledWith({
      suggestedName: 'report.txt',
      content: 'hello\n',
      encoding: 'utf8'
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.readPreview',
      params: { worktree: 'id:wt-1', relativePath: 'report.txt' },
      timeoutMs: 15_000
    })
    expect(fsCancelDownloadedFile).not.toHaveBeenCalled()
  })

  it('downloads a complete zero-byte recognized binary from an older remote runtime', async () => {
    fsSaveDownloadedFile.mockResolvedValue({
      canceled: false,
      destinationPath: '/downloads/empty.png'
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method: files.readChunk'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'preview-1',
        ok: true,
        result: { content: '', isBinary: true, isImage: true, mimeType: 'image/png' },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/empty.png',
        'empty.png'
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/empty.png' })

    expect(fsStartDownloadedFile).not.toHaveBeenCalled()
    expect(fsSaveDownloadedFile).toHaveBeenCalledWith({
      suggestedName: 'empty.png',
      content: '',
      encoding: 'base64'
    })
  })

  it('asks users to update older remote runtimes when preview fallback cannot download the file', async () => {
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method: files.readChunk'
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'preview-1',
        ok: false,
        error: { code: 'runtime_error', message: 'file_too_large' },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/archive.zip',
        'archive.zip'
      )
    ).rejects.toThrow('Remote file download requires a newer Orca server')

    expect(fsStartDownloadedFile).not.toHaveBeenCalled()
    expect(fsSaveDownloadedFile).not.toHaveBeenCalled()
  })

  it('cancels the local temp download when a remote chunk fails', async () => {
    fsStartDownloadedFile.mockResolvedValue({
      canceled: false,
      transferId: 'download-1',
      destinationPath: '/downloads/archive.zip'
    })
    fsCancelDownloadedFile.mockResolvedValue({ ok: true })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'preflight',
        ok: true,
        result: { contentBase64: 'YWJj', bytesRead: 3, eof: false },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'chunk-1',
        ok: true,
        result: { contentBase64: 'YWJj', bytesRead: 3, eof: false },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockRejectedValueOnce(new Error('connection dropped'))

    await expect(
      downloadRuntimeFile(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/archive.zip',
        'archive.zip'
      )
    ).rejects.toThrow('connection dropped')

    expect(fsCancelDownloadedFile).toHaveBeenCalledWith({ transferId: 'download-1' })
    expect(fsFinishDownloadedFile).not.toHaveBeenCalled()
  })
})

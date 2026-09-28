import { describe, expect, it, vi } from 'vitest'
import { downloadRuntimeFile } from './runtime-file-client'
import {
  fsStartDownloadedFile,
  fsAppendDownloadedFileChunk,
  fsFinishDownloadedFile,
  fsCancelDownloadedFile,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const context = {
  settings: { activeRuntimeEnvironmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/remote/repo'
}

function rpcResult(result: unknown) {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

function createTransfer(controller = new AbortController()) {
  const tracker = { addBytes: vi.fn(), completeFile: vi.fn(), flush: vi.fn() }
  return {
    tracker,
    controller,
    transfer: {
      downloadId: 'd1',
      signal: controller.signal,
      trackLocalProgress: vi.fn(() => tracker)
    }
  }
}

describe('runtime file download progress', () => {
  it('reports each appended chunk against the remote file size', async () => {
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
      .mockResolvedValueOnce(rpcResult({ contentBase64: 'YQ==', bytesRead: 1, eof: false }))
      .mockResolvedValueOnce(rpcResult({ size: 4, isDirectory: false, mtime: 1 }))
      .mockResolvedValueOnce(rpcResult({ contentBase64: 'YWJj', bytesRead: 3, eof: false }))
      .mockResolvedValueOnce(rpcResult({ contentBase64: 'ZA==', bytesRead: 1, eof: true }))
    const { transfer, tracker } = createTransfer()

    await expect(
      downloadRuntimeFile(context, '/remote/repo/archive.zip', 'archive.zip', transfer)
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/archive.zip' })

    expect(transfer.trackLocalProgress).toHaveBeenCalledWith(4)
    expect(tracker.addBytes.mock.calls).toEqual([[3], [1]])
    expect(tracker.flush).toHaveBeenCalled()
  })

  it('still downloads with an unknown total when the size lookup fails', async () => {
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
      .mockResolvedValueOnce(rpcResult({ contentBase64: 'YQ==', bytesRead: 1, eof: false }))
      .mockRejectedValueOnce(new Error('stat failed'))
      .mockResolvedValueOnce(rpcResult({ contentBase64: 'ZA==', bytesRead: 1, eof: true }))
    const { transfer } = createTransfer()

    await expect(
      downloadRuntimeFile(context, '/remote/repo/archive.zip', 'archive.zip', transfer)
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/archive.zip' })
    expect(transfer.trackLocalProgress).toHaveBeenCalledWith(null)
  })

  it('stops between chunks and discards the temp file when canceled', async () => {
    fsStartDownloadedFile.mockResolvedValue({
      canceled: false,
      transferId: 'download-1',
      destinationPath: '/downloads/archive.zip'
    })
    fsCancelDownloadedFile.mockResolvedValue({ ok: true })
    const { transfer, controller } = createTransfer()
    fsAppendDownloadedFileChunk.mockImplementation(async () => {
      controller.abort(new Error('Download canceled'))
      return { ok: true }
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce(rpcResult({ contentBase64: 'YQ==', bytesRead: 1, eof: false }))
      .mockResolvedValueOnce(rpcResult({ size: 8, isDirectory: false, mtime: 1 }))
      .mockResolvedValueOnce(rpcResult({ contentBase64: 'YWJj', bytesRead: 3, eof: false }))

    await expect(
      downloadRuntimeFile(context, '/remote/repo/archive.zip', 'archive.zip', transfer)
    ).rejects.toThrow('Download canceled')

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(3)
    expect(fsCancelDownloadedFile).toHaveBeenCalledWith({ transferId: 'download-1' })
    expect(fsFinishDownloadedFile).not.toHaveBeenCalled()
  })
})

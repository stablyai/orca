import { beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadRuntimeFile } from './runtime-file-read-client'
import {
  fsAppendDownloadedFileChunk,
  fsCancelDownloadedFile,
  fsFinishDownloadedFile,
  fsStartDownloadedFile,
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  type RuntimeRpcRequest
} from '../runtime-file-client-test-harness'

type ToastProbe = {
  controller: AbortController
  totalBytes: Promise<number | null> | null
  updates: number[]
}

const toast = vi.hoisted((): ToastProbe => ({
  controller: new AbortController(),
  totalBytes: null,
  updates: []
}))

vi.mock('@/lib/files/download/download-progress-toast', () => ({
  showDownloadProgressToast: (_name: string, totalBytes: Promise<number | null>) => {
    toast.totalBytes = totalBytes
    return {
      signal: toast.controller.signal,
      update: (bytes: number) => toast.updates.push(bytes),
      close: () => {}
    }
  }
}))

installRuntimeFileClientEnvironment()

const META = { runtimeId: 'remote-runtime' }
const FILE_BYTES = 1024 * 1024
const context = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/remote/repo'
}

function isChunkParams(params: unknown): params is { offset: number; length: number } {
  return typeof params === 'object' && params !== null && 'offset' in params && 'length' in params
}

function serveFile({ statFails = false }: { statFails?: boolean } = {}): void {
  runtimeEnvironmentCall.mockImplementation(({ method, params }: RuntimeRpcRequest) => {
    if (method === 'files.stat') {
      return Promise.resolve(
        statFails
          ? {
              id: 'rpc',
              ok: false,
              error: { code: 'method_not_found', message: method },
              _meta: META
            }
          : { id: 'rpc', ok: true, result: { size: FILE_BYTES, mtime: 1 }, _meta: META }
      )
    }
    if (method === 'files.readChunk' && isChunkParams(params)) {
      const { offset, length } = params
      const bytesRead = Math.max(0, Math.min(length, FILE_BYTES - offset))
      return Promise.resolve({
        id: 'rpc',
        ok: true,
        result: {
          contentBase64: Buffer.alloc(bytesRead).toString('base64'),
          bytesRead,
          eof: offset + bytesRead >= FILE_BYTES
        },
        _meta: META
      })
    }
    return Promise.reject(new Error(`unexpected method ${method}`))
  })
}

beforeEach(() => {
  toast.controller = new AbortController()
  toast.totalBytes = null
  toast.updates = []
  fsStartDownloadedFile.mockResolvedValue({ canceled: false, transferId: 't1' })
  fsAppendDownloadedFileChunk.mockResolvedValue(undefined)
  fsFinishDownloadedFile.mockResolvedValue({ canceled: false, destinationPath: '/local/big.bin' })
  fsCancelDownloadedFile.mockResolvedValue(undefined)
})

describe('remote file download progress and cancel', () => {
  it('reports bytes received against the stat size and saves the file', async () => {
    serveFile()

    const result = await downloadRuntimeFile(context, '/remote/repo/big.bin', 'big.bin')

    expect(result).toEqual({ canceled: false, destinationPath: '/local/big.bin' })
    expect(toast.updates).toEqual([393_216, 786_432, 1_048_576])
    await expect(toast.totalBytes).resolves.toBe(1_048_576)
  })

  it('still downloads when the host cannot report the size', async () => {
    serveFile({ statFails: true })

    const result = await downloadRuntimeFile(context, '/remote/repo/big.bin', 'big.bin')

    expect(result).toEqual({ canceled: false, destinationPath: '/local/big.bin' })
    await expect(toast.totalBytes).resolves.toBeNull()
  })

  it('stops reading and discards the partial file when canceled between chunks', async () => {
    serveFile()
    fsAppendDownloadedFileChunk.mockImplementationOnce(async () => {
      toast.controller.abort()
    })

    const result = await downloadRuntimeFile(context, '/remote/repo/big.bin', 'big.bin')

    expect(result).toEqual({ canceled: true })
    expect(fsAppendDownloadedFileChunk).toHaveBeenCalledTimes(1)
    expect(fsFinishDownloadedFile).not.toHaveBeenCalled()
    expect(fsCancelDownloadedFile).toHaveBeenCalledWith({ transferId: 't1' })
  })

  it('does not save the file when canceled during the last write', async () => {
    serveFile()
    fsAppendDownloadedFileChunk
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        toast.controller.abort()
      })

    const result = await downloadRuntimeFile(context, '/remote/repo/big.bin', 'big.bin')

    expect(result).toEqual({ canceled: true })
    expect(fsFinishDownloadedFile).not.toHaveBeenCalled()
    expect(fsCancelDownloadedFile).toHaveBeenCalledWith({ transferId: 't1' })
  })
})

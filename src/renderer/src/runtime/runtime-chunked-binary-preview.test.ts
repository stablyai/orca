import { describe, expect, it } from 'vitest'
import { readRuntimeFileContent, readRuntimeFilePreview } from './runtime-file-client'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  type RuntimeRpcRequest
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const CHUNK_BYTES = 384 * 1024
const META = { runtimeId: 'remote-runtime' }

type ChunkParams = { offset: number; length: number }
type RemoteFile = {
  bytes: Buffer
  /** Stat replies in call order; the last one repeats. */
  stats?: { size: number; mtime: number }[]
  missingMethods?: string[]
  readChunk?: (params: ChunkParams, bytes: Buffer) => unknown
}

function ok(result: unknown): unknown {
  return { id: 'rpc', ok: true, result, _meta: META }
}

function fail(code: string, message: string): unknown {
  return { id: 'rpc', ok: false, error: { code, message }, _meta: META }
}

function sliceChunk({ offset, length }: ChunkParams, bytes: Buffer): unknown {
  const slice = bytes.subarray(offset, offset + length)
  return {
    contentBase64: slice.toString('base64'),
    bytesRead: slice.length,
    eof: offset + slice.length >= bytes.length
  }
}

function isChunkParams(params: unknown): params is ChunkParams {
  return typeof params === 'object' && params !== null && 'offset' in params && 'length' in params
}

/** A paired host whose single-reply preview is over budget, as it is for any binary past ~3 MB. */
function serveOversizedRemoteFile(file: RemoteFile): void {
  const stats = file.stats ?? [{ size: file.bytes.length, mtime: 1 }]
  let statCalls = 0
  runtimeEnvironmentCall.mockImplementation(({ method, params }: RuntimeRpcRequest) => {
    if (file.missingMethods?.includes(method)) {
      return Promise.resolve(fail('method_not_found', `Unknown method: ${method}`))
    }
    if (method === 'files.read') {
      return Promise.resolve(fail('runtime_error', 'binary_file'))
    }
    if (method === 'files.readPreview') {
      return Promise.resolve(fail('runtime_error', 'file_too_large'))
    }
    if (method === 'files.stat') {
      const stat = stats[Math.min(statCalls, stats.length - 1)]
      statCalls += 1
      return Promise.resolve(ok({ ...stat, isDirectory: false }))
    }
    if (method === 'files.readChunk' && isChunkParams(params)) {
      return Promise.resolve(ok((file.readChunk ?? sliceChunk)(params, file.bytes)))
    }
    return Promise.reject(new Error(`unexpected method ${method}`))
  })
}

function patternedBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + (index >> 8)) & 0xff
  }
  return bytes
}

function chunkRequests(): ChunkParams[] {
  return runtimeEnvironmentCall.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === 'files.readChunk')
    .map((request) => request.params)
    .filter(isChunkParams)
    .map(({ offset, length }) => ({ offset, length }))
}

function openRemotePdf(): ReturnType<typeof readRuntimeFileContent> {
  return readRuntimeFileContent({
    settings: { activeRuntimeEnvironmentId: 'env-1' },
    filePath: '/remote/repo/paper.pdf',
    relativePath: 'paper.pdf',
    worktreeId: 'wt-1',
    pageOversizedBinary: true
  })
}

describe('remote previews too large for one reply', () => {
  it('opens a remote PDF by assembling it from chunks', async () => {
    const bytes = patternedBytes(CHUNK_BYTES * 2 + 1000)
    serveOversizedRemoteFile({ bytes })

    await expect(openRemotePdf()).resolves.toEqual({
      content: bytes.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'application/pdf'
    })

    expect(chunkRequests()).toEqual([
      { offset: 0, length: CHUNK_BYTES },
      { offset: CHUNK_BYTES, length: CHUNK_BYTES },
      { offset: CHUNK_BYTES * 2, length: CHUNK_BYTES }
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.readChunk',
      params: { worktree: 'id:wt-1', relativePath: 'paper.pdf', offset: 0, length: CHUNK_BYTES },
      timeoutMs: 60_000
    })
  })

  it('assembles an oversized remote image preview the same way', async () => {
    const bytes = patternedBytes(CHUNK_BYTES + 7)
    serveOversizedRemoteFile({ bytes })

    await expect(
      readRuntimeFilePreview(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/figures/Plot.PNG'
      )
    ).resolves.toEqual({
      content: bytes.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
  })

  it('keeps the size error for a reader that does not render the bytes', async () => {
    serveOversizedRemoteFile({ bytes: patternedBytes(10) })

    // Baseline checks discard binary content, so they must not download a PDF to do it.
    await expect(
      readRuntimeFileContent({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        filePath: '/remote/repo/paper.pdf',
        relativePath: 'paper.pdf',
        worktreeId: 'wt-1'
      })
    ).rejects.toThrow('file_too_large')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.stat' })
    )
    expect(chunkRequests()).toEqual([])
  })

  it('keeps the size error for a file the viewer cannot preview', async () => {
    serveOversizedRemoteFile({ bytes: patternedBytes(10) })

    await expect(
      readRuntimeFilePreview(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/remote/repo/build/output.log'
      )
    ).rejects.toThrow('file_too_large')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.stat' })
    )
    expect(chunkRequests()).toEqual([])
  })

  it('keeps the size error past the cap local and SSH previews share', async () => {
    serveOversizedRemoteFile({
      bytes: patternedBytes(10),
      stats: [{ size: 50 * 1024 * 1024 + 1, mtime: 1 }]
    })

    await expect(openRemotePdf()).rejects.toThrow('file_too_large')
    expect(chunkRequests()).toEqual([])
  })

  it.each(['files.stat', 'files.readChunk'])(
    'keeps the size error on a host without %s',
    async (method) => {
      serveOversizedRemoteFile({ bytes: patternedBytes(10), missingMethods: [method] })

      await expect(openRemotePdf()).rejects.toThrow('file_too_large')
    }
  )

  it('rejects a file rewritten while its chunks were loading', async () => {
    const bytes = patternedBytes(CHUNK_BYTES + 5)
    serveOversizedRemoteFile({
      bytes,
      stats: [
        { size: bytes.length, mtime: 1 },
        { size: bytes.length, mtime: 2 }
      ]
    })

    await expect(openRemotePdf()).rejects.toThrow('changed on disk')
  })

  it('re-reads from a 3-byte boundary after a short chunk', async () => {
    const bytes = patternedBytes(CHUNK_BYTES + 50)
    serveOversizedRemoteFile({
      bytes,
      // A short read that is not EOF: 100 bytes leaves one byte past the last 3-byte group.
      readChunk: (params, source) =>
        sliceChunk(params.offset === 0 ? { offset: 0, length: 100 } : params, source)
    })

    await expect(openRemotePdf()).resolves.toMatchObject({ content: bytes.toString('base64') })
    expect(chunkRequests().map((request) => request.offset)).toEqual([0, 99])
  })

  it('rejects a chunk whose payload does not match its byte count', async () => {
    serveOversizedRemoteFile({
      bytes: patternedBytes(300),
      readChunk: () => ({ contentBase64: 'YWJj', bytesRead: 300, eof: true })
    })

    await expect(openRemotePdf()).rejects.toThrow('invalid chunk')
  })

  it('stops instead of looping when the host never reports the end of the file', async () => {
    const bytes = patternedBytes(300)
    serveOversizedRemoteFile({
      bytes,
      readChunk: () => ({
        contentBase64: bytes.toString('base64'),
        bytesRead: bytes.length,
        eof: false
      })
    })

    await expect(openRemotePdf()).rejects.toThrow('changed on disk')
    expect(chunkRequests()).toHaveLength(2)
  })
})

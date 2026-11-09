import { describe, expect, it } from 'vitest'
import { readRuntimeFileContent } from './runtime-file-read-client'
import {
  fsReadFileChunk,
  fsStat,
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  type RuntimeRpcRequest
} from '../runtime-file-client-test-harness'
import { readRuntimeFileBytes } from './runtime-paged-file-read'

installRuntimeFileClientEnvironment()

const META = { runtimeId: 'remote-runtime' }
const MB = 1024 * 1024
// Mirrors the host: files.read stops at 512 KiB, a files.readPreview reply at about 3 MB.
const READ_CAP = 512 * 1024
const PREVIEW_CAP = 3_142_000

type ChunkParams = { offset: number; length: number }
type RemoteFile = {
  bytes: Buffer
  /** Stat replies in call order; the last one repeats. */
  stats?: { size: number; mtime: number; ctime?: number }[]
  missingMethods?: string[]
  readChunk?: (params: ChunkParams, bytes: Buffer) => unknown
}

const ok = (result: unknown): unknown => ({ id: 'rpc', ok: true, result, _meta: META })
const fail = (code: string, message: string): unknown => ({
  id: 'rpc',
  ok: false,
  error: { code, message },
  _meta: META
})

function sliceChunk(
  { offset, length }: ChunkParams,
  bytes: Buffer
): { contentBase64: string; bytesRead: number; eof: boolean } {
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

/** A paired host with today's single-reply caps and the chunk methods it already has. */
function serveRemoteFile(relativePath: string, file: RemoteFile): void {
  const stats = file.stats ?? [{ size: file.bytes.length, mtime: 1 }]
  const binary = /\.(pdf|png)$/.test(relativePath)
  let statCalls = 0
  runtimeEnvironmentCall.mockImplementation(({ method, params }: RuntimeRpcRequest) => {
    if (file.missingMethods?.includes(method)) {
      return Promise.resolve(fail('method_not_found', `Unknown method: ${method}`))
    }
    if (method === 'files.read') {
      if (binary) {
        return Promise.resolve(fail('runtime_error', 'binary_file'))
      }
      const truncated = file.bytes.length > READ_CAP
      return Promise.resolve(
        ok({
          worktree: 'id:wt-1',
          relativePath,
          content: file.bytes.subarray(0, READ_CAP).toString('utf8'),
          truncated,
          byteLength: Math.min(file.bytes.length, READ_CAP + 1)
        })
      )
    }
    if (method === 'files.readPreview') {
      const cap = binary ? PREVIEW_CAP : READ_CAP
      return Promise.resolve(
        file.bytes.length > cap
          ? fail('runtime_error', 'file_too_large')
          : ok(
              binary
                ? {
                    content: file.bytes.toString('base64'),
                    isBinary: true,
                    isImage: true,
                    mimeType: 'application/pdf'
                  }
                : { content: file.bytes.toString('utf8'), isBinary: false }
            )
      )
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

function htmlBytes(length: number): Buffer {
  const unit = '<p class="row">café — résumé 🚀</p>\n'
  const body = unit.repeat(Math.floor(length / Buffer.byteLength(unit)))
  return Buffer.from(body.padEnd(length - Buffer.byteLength(body) + body.length, 'x'))
}

const remote = (relativePath: string) => ({
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  filePath: `/remote/repo/${relativePath}`,
  relativePath,
  worktreeId: 'wt-1'
})

describe('remote reads larger than one RPC reply', () => {
  it('opens a paged HTML file as complete editable text', async () => {
    const bytes = htmlBytes(2 * MB)
    serveRemoteFile('report.html', { bytes })

    const result = await readRuntimeFileContent(remote('report.html'))

    // Byte equality also proves no multi-byte character was split at a chunk edge.
    expect(result.isBinary).toBe(false)
    expect(Buffer.from(result.content, 'utf8').equals(bytes)).toBe(true)
  })

  it('keeps a UTF-8 BOM so a save does not drop it', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), htmlBytes(MB)])
    serveRemoteFile('table.csv', { bytes })

    const result = await readRuntimeFileContent(remote('table.csv'))

    expect(result.content.charCodeAt(0)).toBe(0xfeff)
    expect(Buffer.from(result.content, 'utf8').equals(bytes)).toBe(true)
  })

  it.each([2, 5])('opens a %i MB PDF in the editor', async (sizeMb) => {
    const bytes = patternedBytes(sizeMb * MB)
    serveRemoteFile('paper.pdf', { bytes })

    const result = await readRuntimeFileContent({
      ...remote('paper.pdf'),
      pageOversizedBinary: true
    })

    expect(result).toMatchObject({ isBinary: true, isImage: true, mimeType: 'application/pdf' })
    expect(Buffer.from(result.content, 'base64').equals(bytes)).toBe(true)
  })

  it('treats a large file with a NUL byte as binary, like a local read', async () => {
    const bytes = htmlBytes(2 * MB)
    bytes[10] = 0
    serveRemoteFile('data.txt', { bytes })

    await expect(readRuntimeFileContent(remote('data.txt'))).resolves.toEqual({
      content: '',
      isBinary: true
    })
  })

  it('rejects a chunk whose payload does not match its byte count', async () => {
    serveRemoteFile('report.html', {
      bytes: htmlBytes(2 * MB),
      readChunk: () => ({ contentBase64: 'YWJj', bytesRead: 9, eof: false })
    })

    await expect(readRuntimeFileContent(remote('report.html'))).rejects.toThrow(
      'Remote file read returned an invalid chunk'
    )
  })
})

describe('whole-file bytes for a bytes custom editor', () => {
  it('returns the exact bytes of a paged remote workbook', async () => {
    const bytes = patternedBytes(MB + 17)
    serveRemoteFile('book.xlsx', { bytes })

    const result = await readRuntimeFileBytes(remote('book.xlsx'), 16 * MB)

    expect(result.kind).toBe('ok')
    expect(result.kind === 'ok' && Buffer.from(result.bytes).equals(bytes)).toBe(true)
  })

  it('reads a local file through the local stat and chunk IPC', async () => {
    const bytes = patternedBytes(300 * 1024)
    fsStat.mockResolvedValue({ size: bytes.length, isDirectory: false, mtime: 5 })
    fsReadFileChunk.mockImplementation((args: ChunkParams) =>
      Promise.resolve(sliceChunk(args, bytes))
    )

    const result = await readRuntimeFileBytes(
      { target: { kind: 'local' }, filePath: '/repo/book.xlsx' },
      16 * MB
    )

    expect(result.kind === 'ok' && Buffer.from(result.bytes).equals(bytes)).toBe(true)
  })
})

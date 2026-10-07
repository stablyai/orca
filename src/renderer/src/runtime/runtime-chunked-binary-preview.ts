import { basename } from '@/lib/path'
import { IMAGE_FILE_MIME_TYPES } from '../../../shared/image-file-extensions'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult
} from '../../../shared/runtime-types'
import type { RuntimeFileSnapshot } from './runtime-file-range-client'
import { callRuntimeRpc, RuntimeRpcCallError, type RuntimeClientTarget } from './runtime-rpc-client'

// Why: a multiple of 3, so one chunk's base64 joins the next with no padding in between.
const PREVIEW_CHUNK_BYTES = 384 * 1024
// Why: the cap local and SSH previews already apply, so a file opens the same on every host.
const CHUNKED_PREVIEW_MAX_BYTES = 50 * 1024 * 1024
const CHANGED_ON_DISK_MESSAGE =
  'File changed on disk while its preview was loading. Reload the file to refresh the preview.'

export type RemotePreviewSource = {
  target: RuntimeClientTarget
  worktree: string
  relativePath: string
}

/**
 * Reads a remote file preview. A paired host answers in one RPC reply, which holds about 3 MB of
 * binary; with `pageOversizedBinary`, a larger PDF or image is assembled from `files.readChunk`.
 */
export async function readRemoteFilePreview(
  source: RemotePreviewSource,
  options: { pageOversizedBinary: boolean }
): Promise<RuntimeFilePreviewResult> {
  try {
    return await callRuntimeRpc<RuntimeFilePreviewResult>(
      source.target,
      'files.readPreview',
      { worktree: source.worktree, relativePath: source.relativePath },
      { timeoutMs: 15_000 }
    )
  } catch (error) {
    if (!options.pageOversizedBinary || !isRuntimeError(error, 'file_too_large')) {
      throw error
    }
    const mimeType = previewableBinaryMimeType(source.relativePath)
    if (!mimeType) {
      throw error
    }
    // Why: a host that cannot page, or a file past the shared cap, keeps the size error it had.
    const content = await readBase64InChunks(source)
    if (content === null) {
      throw error
    }
    return { content, isBinary: true, isImage: true, mimeType }
  }
}

function previewableBinaryMimeType(relativePath: string): string | undefined {
  const name = basename(relativePath)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return undefined
  }
  const extension = name.slice(dot).toLowerCase()
  return extension === '.pdf' ? 'application/pdf' : IMAGE_FILE_MIME_TYPES[extension]
}

function isRuntimeError(error: unknown, message: string): boolean {
  return error instanceof RuntimeRpcCallError && error.message === message
}

/** Null when an older host lacks the method, so the caller can keep its original error. */
async function callOrNullWhenUnsupported<TResult>(
  call: () => Promise<TResult>
): Promise<TResult | null> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return null
    }
    throw error
  }
}

function statRemoteFile(source: RemotePreviewSource): Promise<RuntimeFileSnapshot> {
  return callRuntimeRpc<RuntimeFileSnapshot>(
    source.target,
    'files.stat',
    { worktree: source.worktree, relativePath: source.relativePath },
    { timeoutMs: 15_000 }
  )
}

async function readBase64InChunks(source: RemotePreviewSource): Promise<string | null> {
  const before = await callOrNullWhenUnsupported(() => statRemoteFile(source))
  if (!before || before.isDirectory || before.size > CHUNKED_PREVIEW_MAX_BYTES) {
    return null
  }
  const parts: string[] = []
  let offset = 0
  for (;;) {
    const chunkOffset = offset
    const chunk = await callOrNullWhenUnsupported(() =>
      callRuntimeRpc<RuntimeFileReadChunkResult>(
        source.target,
        'files.readChunk',
        {
          worktree: source.worktree,
          relativePath: source.relativePath,
          offset: chunkOffset,
          length: PREVIEW_CHUNK_BYTES
        },
        { timeoutMs: 60_000 }
      )
    )
    if (!chunk) {
      return null
    }
    const { bytesRead, contentBase64, eof } = chunk
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead < 0 ||
      bytesRead > PREVIEW_CHUNK_BYTES ||
      typeof contentBase64 !== 'string' ||
      contentBase64.length !== Math.ceil(bytesRead / 3) * 4
    ) {
      throw new Error('Remote preview returned an invalid chunk')
    }
    // Why: base64 only joins on 3-byte boundaries, so a short chunk is cut back to one and its
    // tail re-read.
    const usableBytes = eof ? bytesRead : bytesRead - (bytesRead % 3)
    parts.push(eof ? contentBase64 : contentBase64.slice(0, (usableBytes / 3) * 4))
    offset += usableBytes
    // Why: the stat bounds the loop, so a host that never reports EOF cannot keep it running.
    if (offset > before.size || (!eof && usableBytes === 0)) {
      throw new Error(CHANGED_ON_DISK_MESSAGE)
    }
    if (eof) {
      break
    }
  }
  // Why: chunks are separate reads, so a rewrite between them (a PDF rebuild) would splice two
  // versions into one corrupt document.
  const after = await statRemoteFile(source)
  if (offset !== before.size || after.size !== before.size || after.mtime !== before.mtime) {
    throw new Error(CHANGED_ON_DISK_MESSAGE)
  }
  return parts.join('')
}

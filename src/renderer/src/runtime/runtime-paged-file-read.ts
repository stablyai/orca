import { BINARY_PROBE_BYTES } from '../../../shared/binary-buffer'
import {
  IMAGE_AND_PDF_PREVIEW_MIME_TYPES,
  filePreviewExtension
} from '../../../shared/file-preview-kind'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult
} from '../../../shared/runtime-types'
import {
  rangeReadTarget,
  readRemoteRuntimeFileChunk,
  readRuntimeFileChunk,
  statRemoteRuntimeFile,
  type RuntimeFileSnapshot,
  type RuntimeRemoteFileAddress
} from './runtime-file-range-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { callRuntimeRpc } from './runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { MAX_FILE_RANGE_READ_BYTES } from '../../../shared/file-range-read'
import type { RuntimeFileReadArgs } from './runtime-file-client-types'

// Why: under files.readChunk's 512 KiB cap, and a multiple of 3 so its base64 has no padding.
const PAGED_READ_CHUNK_BYTES = 384 * 1024
// Why: the cap local and SSH reads already apply, so a file opens the same on every host.
export const PAGED_REMOTE_FILE_MAX_BYTES = 50 * 1024 * 1024
export const REMOTE_FILE_CHANGED_DURING_READ_MESSAGE =
  'File changed on disk while it was loading. Reload the file to see the latest version.'

export type PagedRemoteFileRead =
  | { kind: 'ok'; bytes: Uint8Array<ArrayBuffer> }
  // An older host without files.stat/files.readChunk: the caller keeps its one-reply error.
  | { kind: 'unsupported' }
  | { kind: 'too_large'; size: number }

/** Captures the pairing once, before the first call, so a re-pair cannot switch hosts mid-read. */
export function pinRemoteFileAddress(address: RuntimeRemoteFileAddress): RuntimeRemoteFileAddress {
  return {
    ...address,
    expectedEnvironmentPairingRevision: captureRuntimeEnvironmentRequestRevision(
      address.target.environmentId,
      address.expectedEnvironmentPairingRevision
    )
  }
}

/**
 * Reads a whole remote file with `files.readChunk`, for files too large for one RPC reply
 * (`files.read` stops at 512 KiB, `files.readPreview` at about 3 MB). No wire change: both
 * methods already exist on hosts that page CSVs and downloads.
 */
export async function readRemoteFileInChunks(
  address: RuntimeRemoteFileAddress
): Promise<PagedRemoteFileRead> {
  const remote = pinRemoteFileAddress(address)
  return readFileInChunks({
    stat: () => statRemoteRuntimeFile(remote),
    readChunk: (offset, length) => readRemoteRuntimeFileChunk(remote, offset, length)
  })
}

/** Host calls for one file; a paired web client binds them to its own session. */
export type ChunkedFileReader = {
  stat: () => Promise<RuntimeFileSnapshot>
  readChunk: (offset: number, length: number) => Promise<RuntimeFileReadChunkResult>
}

/** The paging loop behind `readRemoteFileInChunks`, over any way of calling the host. */
export async function readFileInChunks(
  reader: ChunkedFileReader,
  limits: { maxBytes?: number; chunkBytes?: number } = {}
): Promise<PagedRemoteFileRead> {
  const maxBytes = limits.maxBytes ?? PAGED_REMOTE_FILE_MAX_BYTES
  const chunkBytes = limits.chunkBytes ?? PAGED_READ_CHUNK_BYTES
  const before = await nullWhenUnsupported(() => reader.stat())
  if (!before) {
    return { kind: 'unsupported' }
  }
  if (before.isDirectory) {
    throw new Error('Remote path is a directory')
  }
  if (before.size > maxBytes) {
    return { kind: 'too_large', size: before.size }
  }
  const bytes = new Uint8Array(before.size)
  let offset = 0
  for (;;) {
    const chunk = await nullWhenUnsupported(() => reader.readChunk(offset, chunkBytes))
    if (!chunk) {
      return { kind: 'unsupported' }
    }
    const decoded = decodeChunk(chunk.contentBase64, chunk.bytesRead)
    // Why: the stat bounds the loop, so a growing file or a host that never reports EOF stops.
    if (offset + decoded.length > before.size || (!chunk.eof && decoded.length === 0)) {
      throw new Error(REMOTE_FILE_CHANGED_DURING_READ_MESSAGE)
    }
    bytes.set(decoded, offset)
    offset += decoded.length
    if (chunk.eof) {
      break
    }
  }
  // Separate chunks can straddle rewrites such as PDF rebuilds; validate metadata to avoid splicing corrupt versions.
  const after = await reader.stat()
  if (
    offset !== before.size ||
    after.size !== before.size ||
    after.mtime !== before.mtime ||
    after.ctime !== before.ctime
  ) {
    throw new Error(REMOTE_FILE_CHANGED_DURING_READ_MESSAGE)
  }
  return { kind: 'ok', bytes }
}

/** A binary the host refused as text: only images and PDFs preview, so no other is fetched. */
export async function readRemoteBinaryFile(
  address: RuntimeRemoteFileAddress,
  options: { pageOversized: boolean }
): Promise<RuntimeFilePreviewResult> {
  return previewableBinaryMimeType(address.relativePath)
    ? readRemoteFilePreview(address, options)
    : { content: '', isBinary: true }
}

/**
 * A whole file's bytes on the route the editor loaded it from: this client's file system or the
 * owning runtime (SSH and paired hosts), pinned to one pairing. Chunks stay within the local
 * `fs:readFileChunk` cap; the stat bracket refuses a file rewritten mid-read.
 */
export function readRuntimeFileBytes(
  args: RuntimeFileReadArgs,
  maxBytes: number
): Promise<PagedRemoteFileRead> {
  const target = rangeReadTarget(args)
  const remote = target ? pinRemoteFileAddress(target) : null
  return readFileInChunks(
    {
      stat: () =>
        remote
          ? statRemoteRuntimeFile(remote)
          : window.api.fs.stat({
              filePath: args.filePath,
              connectionId: args.connectionId,
              access: args.access
            }),
      readChunk: (offset, length) => readRuntimeFileChunk(args, remote, offset, length)
    },
    { maxBytes, chunkBytes: MAX_FILE_RANGE_READ_BYTES }
  )
}

/** `files.readPreview`, falling back to a chunked read when the file is too large for one reply. */
export async function readRemoteFilePreview(
  address: RuntimeRemoteFileAddress,
  options: { pageOversized: boolean }
): Promise<RuntimeFilePreviewResult> {
  const remote = pinRemoteFileAddress(address)
  try {
    return await callRuntimeRpc<RuntimeFilePreviewResult>(
      remote.target,
      'files.readPreview',
      { worktree: remote.worktree, relativePath: remote.relativePath },
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
      }
    )
  } catch (error) {
    if (
      !options.pageOversized ||
      !(error instanceof RuntimeRpcCallError && error.message === 'file_too_large')
    ) {
      throw error
    }
    const paged = await readRemoteFileInChunks(remote)
    // Why: an older host that cannot page, or a file past the shared cap, keeps its size error.
    if (paged.kind !== 'ok') {
      throw error
    }
    return pagedFilePreviewResult(remote.relativePath, paged.bytes)
  }
}

/** The `files.readPreview` result for bytes the host was too large to send in one reply. */
export function pagedFilePreviewResult(
  relativePath: string,
  bytes: Uint8Array
): RuntimeFilePreviewResult {
  const mimeType = previewableBinaryMimeType(relativePath)
  if (mimeType) {
    return { content: bytesToBase64(bytes), isBinary: true, isImage: true, mimeType }
  }
  return pagedTextFileResult(bytes)
}

/** Text the way local reads decode it: a NUL in the probe window marks the file binary. */
export function pagedTextFileResult(bytes: Uint8Array): RuntimeFilePreviewResult {
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { content: '', isBinary: true }
  }
  // Why: keep a BOM like the host's Buffer decode, or a save would silently drop it.
  return { content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), isBinary: false }
}

/** The image/PDF previews the host's `files.readPreview` sends whole; one table for both sides. */
export function previewableBinaryMimeType(relativePath: string): string | undefined {
  return IMAGE_AND_PDF_PREVIEW_MIME_TYPES[filePreviewExtension(relativePath)]
}

async function nullWhenUnsupported<TResult>(call: () => Promise<TResult>): Promise<TResult | null> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return null
    }
    throw error
  }
}

function decodeChunk(contentBase64: unknown, bytesRead: unknown): Uint8Array {
  if (
    typeof contentBase64 !== 'string' ||
    !Number.isSafeInteger(bytesRead) ||
    contentBase64.length !== Math.ceil(Number(bytesRead) / 3) * 4
  ) {
    throw new Error('Remote file read returned an invalid chunk')
  }
  const binary = atob(contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  if (bytes.length !== bytesRead) {
    throw new Error('Remote file read returned an invalid chunk')
  }
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  // Why: a multiple of 3, so slices join without padding; small enough for fromCharCode's args.
  const slice = 0x2000 * 3
  for (let start = 0; start < bytes.length; start += slice) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + slice))))
  }
  return parts.join('')
}

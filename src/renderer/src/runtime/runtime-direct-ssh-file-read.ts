import { basename } from '@/lib/path'
import { BINARY_PROBE_BYTES } from '../../../shared/file-preview/binary-buffer'
import { IMAGE_FILE_MIME_TYPES } from '../../../shared/file-preview/image-mime-types'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult
} from '../../../shared/file-content/runtime-file-read'
import { callRuntimeRpc } from './rpc/calls/runtime-rpc-call'
import type {
  RuntimeFileOperationArgs,
  RuntimeFileReadArgs,
  RuntimeReadableFileContent
} from './files/runtime-file-client-types'
import { isTauriNativeHost } from '@/web/tauri-native-bridge'

const DIRECT_SSH_READ_CHUNK_BYTES = 384 * 1024
const DIRECT_SSH_MAX_FILE_BYTES = 50 * 1024 * 1024

export type DirectSshFileReadChunk = RuntimeFileReadChunkResult & {
  size: number
  mtime: number
}

export type DirectSshFileSnapshot = {
  size: number
  isDirectory: false
  mtime: number
}

type DirectSshFileContext = Pick<
  RuntimeFileOperationArgs,
  'target' | 'connectionId' | 'expectedSshConnectionGeneration'
>

export function isDirectSshFileContext(
  context: Pick<RuntimeFileOperationArgs, 'target' | 'connectionId'>
): context is DirectSshFileContext & { connectionId: string } {
  return isTauriNativeHost() && context.target.kind === 'local' && Boolean(context.connectionId)
}

export async function readDirectSshFileChunk(
  context: DirectSshFileContext,
  filePath: string,
  offset: number,
  length: number
): Promise<DirectSshFileReadChunk> {
  if (!context.connectionId) {
    throw new Error('SSH file read has no owning connection')
  }
  return callRuntimeRpc<DirectSshFileReadChunk>(
    { kind: 'local' },
    'ssh.readFileChunk',
    {
      targetId: context.connectionId,
      filePath,
      offset,
      length,
      ...(context.expectedSshConnectionGeneration === undefined
        ? {}
        : { expectedGeneration: context.expectedSshConnectionGeneration })
    },
    { timeoutMs: 60_000 }
  )
}

export async function statDirectSshFile(
  context: DirectSshFileContext,
  filePath: string
): Promise<DirectSshFileSnapshot> {
  const chunk = await readDirectSshFileChunk(context, filePath, 0, 1)
  return { size: chunk.size, isDirectory: false, mtime: chunk.mtime }
}

export async function readDirectSshFileContent(
  context: RuntimeFileReadArgs
): Promise<RuntimeReadableFileContent> {
  const result = await readDirectSshFileBytes(context, context.filePath)
  return directSshPreviewResult(context.filePath, result)
}

export async function readDirectSshFilePreview(
  context: DirectSshFileContext,
  filePath: string
): Promise<RuntimeFilePreviewResult> {
  const bytes = await readDirectSshFileBytes(context, filePath)
  return directSshPreviewResult(filePath, bytes)
}

export async function cacheDirectSshFilePreview(
  context: DirectSshFileContext,
  grantId: string,
  relativePath: string,
  filePath: string
): Promise<boolean> {
  const preview = await readDirectSshFilePreview(context, filePath)
  if (preview.isBinary && (!preview.mimeType || !preview.content)) {
    return false
  }
  const contentBase64 = preview.isBinary
    ? preview.content
    : bytesToBase64(new TextEncoder().encode(preview.content))
  return window.api.docPreview.cacheFile({
    grantId,
    relativePath,
    filePath,
    contentBase64,
    ...(preview.mimeType ? { contentType: preview.mimeType } : {})
  })
}

export async function downloadDirectSshFile(
  context: DirectSshFileContext,
  filePath: string,
  suggestedName: string
): Promise<{ canceled: true } | { canceled: false; destinationPath: string }> {
  const download = await window.api.fs.startDownloadedFile({ suggestedName })
  if (download.canceled) {
    return download
  }

  let finished = false
  try {
    let offset = 0
    for (;;) {
      const chunk = await readDirectSshFileChunk(
        context,
        filePath,
        offset,
        DIRECT_SSH_READ_CHUNK_BYTES
      )
      if (chunk.bytesRead > 0) {
        await window.api.fs.appendDownloadedFileChunk({
          transferId: download.transferId,
          contentBase64: chunk.contentBase64
        })
      }
      if (offset + chunk.bytesRead > chunk.size) {
        throw new Error('Remote file download returned more bytes than its reported size')
      }
      offset += chunk.bytesRead
      if (chunk.eof) {
        break
      }
      if (chunk.bytesRead <= 0) {
        throw new Error('Remote file download stalled before reaching EOF')
      }
    }
    const result = await window.api.fs.finishDownloadedFile({ transferId: download.transferId })
    finished = true
    return result
  } finally {
    if (!finished) {
      await window.api.fs.cancelDownloadedFile({ transferId: download.transferId }).catch(() => {})
    }
  }
}

async function readDirectSshFileBytes(
  context: DirectSshFileContext,
  filePath: string
): Promise<Uint8Array> {
  const before = await statDirectSshFile(context, filePath)
  if (before.size > DIRECT_SSH_MAX_FILE_BYTES) {
    throw new Error('file_too_large')
  }
  const bytes = new Uint8Array(before.size)
  let offset = 0
  for (;;) {
    const chunk = await readDirectSshFileChunk(
      context,
      filePath,
      offset,
      DIRECT_SSH_READ_CHUNK_BYTES
    )
    const decoded = decodeChunk(chunk.contentBase64, chunk.bytesRead)
    if (
      offset + decoded.length > before.size ||
      (!chunk.eof && decoded.length === 0) ||
      chunk.size !== before.size ||
      chunk.mtime !== before.mtime
    ) {
      throw new Error(
        'File changed on disk while it was loading. Reload the file to see the latest version.'
      )
    }
    bytes.set(decoded, offset)
    offset += decoded.length
    if (chunk.eof) {
      break
    }
  }
  if (offset !== before.size) {
    throw new Error(
      'File changed on disk while it was loading. Reload the file to see the latest version.'
    )
  }
  const after = await statDirectSshFile(context, filePath)
  if (after.size !== before.size || after.mtime !== before.mtime) {
    throw new Error(
      'File changed on disk while it was loading. Reload the file to see the latest version.'
    )
  }
  return bytes
}

function directSshPreviewResult(filePath: string, bytes: Uint8Array): RuntimeFilePreviewResult {
  const mimeType = previewableBinaryMimeType(filePath)
  if (mimeType) {
    return { content: bytesToBase64(bytes), isBinary: true, isImage: true, mimeType }
  }
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { content: '', isBinary: true }
  }
  return { content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), isBinary: false }
}

function previewableBinaryMimeType(filePath: string): string | undefined {
  const name = basename(filePath)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return undefined
  }
  const extension = name.slice(dot).toLowerCase()
  return extension === '.pdf' ? 'application/pdf' : IMAGE_FILE_MIME_TYPES[extension]
}

function decodeChunk(contentBase64: unknown, bytesRead: unknown): Uint8Array {
  if (
    typeof contentBase64 !== 'string' ||
    !Number.isSafeInteger(bytesRead) ||
    Number(bytesRead) < 0 ||
    contentBase64.length !== Math.ceil(Number(bytesRead) / 3) * 4
  ) {
    throw new Error('Remote file read returned an invalid chunk')
  }
  const binary = atob(contentBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytes.length !== bytesRead) {
    throw new Error('Remote file read returned an invalid chunk')
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const slice = 0x2000 * 3
  for (let start = 0; start < bytes.length; start += slice) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + slice))))
  }
  return parts.join('')
}

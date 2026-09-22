import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult,
  RuntimeFileReadResult
} from '../../../shared/runtime-types'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'
import type {
  RuntimeFileDownloadResult,
  RuntimeFileOperationArgs,
  RuntimeFileReadArgs,
  RuntimeReadableFileContent
} from './runtime-file-client-types'
import {
  assertExternalSshReadOwnership,
  canReadRelativeRuntimeFile,
  getRemoteFileArgs,
  hasRemoteRuntimeOwner
} from './runtime-file-routing'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const REMOTE_DOWNLOAD_CHUNK_BYTES = 384 * 1024
const REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE =
  'Remote file download requires a newer Orca server. Update the headless server and try again.'

type RemoteFileDownloadArgs = NonNullable<ReturnType<typeof getRemoteFileArgs>>

export async function readRuntimeFileContent({
  settings,
  filePath,
  relativePath,
  worktreeId,
  connectionId,
  expectedExternalSshTargetId,
  includeLocalLogMetadata
}: RuntimeFileReadArgs): Promise<RuntimeReadableFileContent> {
  assertExternalSshReadOwnership(settings, connectionId, expectedExternalSshTargetId)
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.fs.readFile({ filePath, connectionId, includeLocalLogMetadata })
  }
  if (!worktreeId) {
    return window.api.fs.readFile({ filePath, connectionId, includeLocalLogMetadata })
  }
  if (!canReadRelativeRuntimeFile(relativePath)) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }

  const worktree = toRuntimeWorktreeSelector(worktreeId)
  let result: RuntimeFileReadResult
  try {
    result = await callRuntimeRpc<RuntimeFileReadResult>(
      target,
      'files.read',
      { worktree, relativePath },
      { timeoutMs: 15_000 }
    )
  } catch (err) {
    // Why: files.read rejects binary paths with the typed 'binary_file' error; fall
    // back to the base64 preview RPC so PDFs/images render like local/SSH paths.
    // Match the exact typed error so an unrelated failure can't spoof the fallback.
    if (err instanceof RuntimeRpcCallError && err.message === 'binary_file') {
      return callRuntimeRpc<RuntimeFilePreviewResult>(
        target,
        'files.readPreview',
        { worktree, relativePath },
        { timeoutMs: 15_000 }
      )
    }
    throw err
  }
  if (result.truncated) {
    // Why: the runtime file RPC is preview-sized today; treating a truncated
    // payload as editable content would make saves overwrite the rest of the file.
    throw new Error(`Remote file is too large to open in the editor (${result.byteLength} bytes)`)
  }
  return { content: result.content, isBinary: false }
}

export async function readRuntimeFilePreview(
  context: RuntimeFileOperationArgs,
  filePath: string
): Promise<RuntimeFilePreviewResult> {
  assertExternalSshReadOwnership(
    context.settings,
    context.connectionId,
    context.expectedExternalSshTargetId
  )
  const remoteArgs = getRemoteFileArgs(context, filePath)
  if (!remoteArgs) {
    if (hasRemoteRuntimeOwner(context)) {
      throw new Error('Remote file is outside the owning runtime worktree')
    }
    return window.api.fs.readFile({ filePath, connectionId: context.connectionId })
  }
  return callRuntimeRpc<RuntimeFilePreviewResult>(
    remoteArgs.target,
    'files.readPreview',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
    { timeoutMs: 15_000 }
  )
}

export async function downloadRuntimeFile(
  context: RuntimeFileOperationArgs,
  filePath: string,
  suggestedName: string
): Promise<RuntimeFileDownloadResult> {
  assertExternalSshReadOwnership(
    context.settings,
    context.connectionId,
    context.expectedExternalSshTargetId
  )
  const remoteArgs = getRemoteFileArgs(context, filePath)
  if (!remoteArgs) {
    if (hasRemoteRuntimeOwner(context)) {
      throw new Error('Remote file is outside the owning runtime worktree')
    }
    if (context.connectionId) {
      return window.api.fs.downloadFile({ filePath, connectionId: context.connectionId })
    }
    const result = await readRuntimeFilePreview(context, filePath)
    return window.api.fs.saveDownloadedFile({
      suggestedName,
      content: result.content,
      encoding: result.isBinary ? 'base64' : 'utf8'
    })
  }

  if (!(await remoteChunkedDownloadAvailable(remoteArgs))) {
    return downloadRemoteFileViaPreview(remoteArgs, suggestedName)
  }

  const download = await window.api.fs.startDownloadedFile({ suggestedName })
  if (download.canceled) {
    return download
  }

  let finished = false
  try {
    let offset = 0
    for (;;) {
      const chunk = await readRemoteDownloadChunk(remoteArgs, offset)
      if (chunk.bytesRead > 0) {
        await window.api.fs.appendDownloadedFileChunk({
          transferId: download.transferId,
          contentBase64: chunk.contentBase64
        })
      }
      offset += chunk.bytesRead
      if (chunk.eof) {
        break
      }
      if (chunk.bytesRead <= 0) {
        throw new Error('Remote download stalled before reaching EOF')
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

async function remoteChunkedDownloadAvailable(
  remoteArgs: RemoteFileDownloadArgs
): Promise<boolean> {
  try {
    await callRuntimeRpc<RuntimeFileReadChunkResult>(
      remoteArgs.target,
      'files.readChunk',
      {
        worktree: remoteArgs.worktreeSelector,
        relativePath: remoteArgs.relativePath,
        offset: 0,
        length: 1
      },
      { timeoutMs: 60_000 }
    )
    return true
  } catch (error) {
    // Why: compatible older headless servers may lack chunked downloads while
    // still supporting preview-sized file reads that can complete the request.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return false
    }
    throw error
  }
}

async function readRemoteDownloadChunk(
  remoteArgs: RemoteFileDownloadArgs,
  offset: number
): Promise<RuntimeFileReadChunkResult> {
  return callRuntimeRpc<RuntimeFileReadChunkResult>(
    remoteArgs.target,
    'files.readChunk',
    {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath,
      offset,
      length: REMOTE_DOWNLOAD_CHUNK_BYTES
    },
    { timeoutMs: 60_000 }
  )
}

async function downloadRemoteFileViaPreview(
  remoteArgs: RemoteFileDownloadArgs,
  suggestedName: string
): Promise<RuntimeFileDownloadResult> {
  try {
    const result = await callRuntimeRpc<RuntimeFilePreviewResult>(
      remoteArgs.target,
      'files.readPreview',
      { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
      { timeoutMs: 15_000 }
    )
    // Why: old servers use an empty, metadata-free binary result to signal an
    // unsupported binary; recognized zero-byte previews are still complete.
    if (result.isBinary && !result.content && !result.isImage && !result.mimeType) {
      throw new Error(REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE)
    }
    return window.api.fs.saveDownloadedFile({
      suggestedName,
      content: result.content,
      encoding: result.isBinary ? 'base64' : 'utf8'
    })
  } catch (error) {
    if (isUnsupportedRemotePreviewDownload(error)) {
      throw new Error(REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE)
    }
    throw error
  }
}

function isUnsupportedRemotePreviewDownload(error: unknown): boolean {
  if (!(error instanceof RuntimeRpcCallError)) {
    return false
  }
  return (
    error.code === 'method_not_found' ||
    (error.code === 'runtime_error' &&
      (error.message === 'file_too_large' || error.message === 'binary_file'))
  )
}

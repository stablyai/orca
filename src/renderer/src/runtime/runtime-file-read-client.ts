import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult,
  RuntimeFileReadResult
} from '../../../shared/runtime-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
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
import { chatScratchFileAddress } from './runtime-chat-scratch-file-address'
import { isAgentSessionAttachmentStorePath } from '../../../shared/agent-session-attachments'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import { readRuntimeTerminalArtifactContent } from './runtime-terminal-artifact-read'
import {
  pagedTextFileResult,
  pinRemoteFileAddress,
  readRemoteFileInChunks,
  readRemoteFilePreview
} from './runtime-paged-file-read'

const REMOTE_DOWNLOAD_CHUNK_BYTES = 384 * 1024
const REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE =
  'Remote file download requires a newer Orca server. Update the headless server and try again.'

type RemoteFileDownloadArgs = NonNullable<ReturnType<typeof getRemoteFileArgs>>

// Why local only: an SSH read is the remote host's to check, and its relay never sees this field.
export function localAccess(
  connectionId: string | undefined,
  access: LocalFileAccess | undefined
): { access?: LocalFileAccess } {
  return access && !connectionId ? { access } : {}
}

export async function readRuntimeFileContent({
  target,
  filePath,
  relativePath,
  worktreeId,
  connectionId,
  expectedExternalSshTargetId,
  includeLocalLogMetadata,
  access,
  terminalArtifactGrantId,
  pageOversizedBinary
}: RuntimeFileReadArgs): Promise<RuntimeReadableFileContent> {
  assertExternalSshReadOwnership(target, connectionId, expectedExternalSshTargetId)
  if (target.kind !== 'environment' || !worktreeId) {
    return window.api.fs.readFile({
      filePath,
      connectionId,
      includeLocalLogMetadata,
      ...localAccess(connectionId, access)
    })
  }
  if (terminalArtifactGrantId) {
    return readRuntimeTerminalArtifactContent({
      target,
      worktreeId,
      absolutePath: filePath,
      grantId: terminalArtifactGrantId
    })
  }
  // A workspace path first; a chat's scratch file is the absolute path no workspace contains.
  const scratch = canReadRelativeRuntimeFile(relativePath) ? null : chatScratchFileAddress(filePath)
  const readPath = scratch?.relativePath ?? relativePath
  if (!canReadRelativeRuntimeFile(readPath)) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }

  const remote = pinRemoteFileAddress({
    target,
    worktree: scratch?.worktreeSelector ?? toRuntimeWorktreeSelector(worktreeId),
    relativePath: readPath
  })
  let result: RuntimeFileReadResult
  try {
    result = await callRuntimeRpc<RuntimeFileReadResult>(
      target,
      'files.read',
      { worktree: remote.worktree, relativePath: readPath },
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
      }
    )
  } catch (err) {
    // Why: files.read rejects binary paths with the typed 'binary_file' error; fall
    // back to the base64 preview RPC so PDFs/images render like local/SSH paths.
    // Match the exact typed error so an unrelated failure can't spoof the fallback.
    if (err instanceof RuntimeRpcCallError && err.message === 'binary_file') {
      // Why: baseline checks call this too and discard binary content, so paging is opt-in.
      return readRemoteFilePreview(remote, { pageOversized: pageOversizedBinary === true })
    }
    throw err
  }
  if (result.truncated) {
    // Why: files.read stops at 512 KiB to fit one reply; a truncated payload saved as
    // editable content would drop the rest of the file, so read the whole file in chunks.
    const paged = await readRemoteFileInChunks(remote)
    if (paged.kind === 'ok') {
      return pagedTextFileResult(paged.bytes)
    }
    throw new Error(
      paged.kind === 'unsupported'
        ? 'Remote file is larger than the 512 KB this Orca server can send. Update the server to open it.'
        : `Remote file is too large to open in the editor (${paged.size} bytes)`
    )
  }
  return { content: result.content, isBinary: false }
}

export async function readRuntimeFilePreview(
  context: RuntimeFileOperationArgs,
  filePath: string,
  access?: LocalFileAccess
): Promise<RuntimeFilePreviewResult> {
  assertExternalSshReadOwnership(
    context.target,
    context.connectionId,
    context.expectedExternalSshTargetId
  )
  const remoteArgs = getRemoteFileArgs(context, filePath)
  const runtimeTarget = context.target
  // A chat attachment lives in the paired server's store, outside every worktree; that server
  // reads it back itself (an older one answers method_not_found, and the preview falls back).
  if (
    !remoteArgs &&
    runtimeTarget.kind === 'environment' &&
    isAgentSessionAttachmentStorePath(filePath)
  ) {
    return callRuntimeRpc<RuntimeFilePreviewResult>(
      runtimeTarget,
      'agentSessionAttachment.read',
      { path: filePath },
      { timeoutMs: 15_000 }
    )
  }
  if (!remoteArgs) {
    if (hasRemoteRuntimeOwner(context)) {
      throw new Error('Remote file is outside the owning runtime worktree')
    }
    return window.api.fs.readFile({
      filePath,
      connectionId: context.connectionId,
      ...localAccess(context.connectionId, access)
    })
  }
  return readRemoteFilePreview(
    {
      target: remoteArgs.target,
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath
    },
    { pageOversized: true }
  )
}

export async function downloadRuntimeFile(
  context: RuntimeFileOperationArgs,
  filePath: string,
  suggestedName: string
): Promise<RuntimeFileDownloadResult> {
  assertExternalSshReadOwnership(
    context.target,
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

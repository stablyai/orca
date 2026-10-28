import type { RuntimeFilePreviewResult, RuntimeFileReadResult } from '../../../shared/runtime-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { BINARY_PROBE_BYTES } from '../../../shared/binary-buffer'
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
  hasRemoteRuntimeOwner,
  localAccess
} from './runtime-file-routing'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { chatScratchFileAddress } from './runtime-chat-scratch-file-address'
import { isAgentSessionAttachmentStorePath } from '../../../shared/agent-session-attachments'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import {
  isHostFileOutsideWorkspaces,
  readHostFilePreview,
  readHostFileOutsideWorkspaces
} from './runtime-terminal-artifact-read'
import {
  pagedTextFileResult,
  pinRemoteFileAddress,
  readRemoteBinaryFile,
  readRemoteFileInChunks,
  readRemoteFilePreview
} from './runtime-paged-file-read'
import {
  downloadRemoteFileViaPreview,
  readRemoteDownloadChunk,
  remoteChunkedDownloadAvailable
} from './runtime-remote-file-download'

export { localAccess } from './runtime-file-routing'

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
  expectedEnvironmentPairingRevision,
  pageOversizedBinary,
  wakeWslDistro
}: RuntimeFileReadArgs): Promise<RuntimeReadableFileContent> {
  assertExternalSshReadOwnership(target, connectionId, expectedExternalSshTargetId)
  if (target.kind !== 'environment' || !worktreeId) {
    return window.api.fs.readFile({
      filePath,
      connectionId,
      includeLocalLogMetadata,
      ...localAccess(connectionId, access),
      ...(wakeWslDistro && !connectionId ? { wakeWslDistro } : {})
    })
  }
  // Why: decided synchronously so ordinary reads pin their pairing without an extra await.
  if (isHostFileOutsideWorkspaces({ filePath, relativePath, grantId: terminalArtifactGrantId })) {
    return readHostFileOutsideWorkspaces({
      target,
      worktreeId,
      filePath,
      relativePath,
      grantId: terminalArtifactGrantId,
      expectedEnvironmentPairingRevision
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
    // Typed binary_file refusal permits base64 preview for PDFs/images; unrelated errors cannot spoof this fallback.
    if (err instanceof RuntimeRpcCallError && err.message === 'binary_file') {
      // Why: baseline checks call this too and discard binary content, so paging is opt-in.
      return readRemoteBinaryFile(remote, { pageOversized: pageOversizedBinary === true })
    }
    throw err
  }
  // Hosts before content sniffing send an unlisted binary as text; NUL is git's binary signal.
  if (result.content.slice(0, BINARY_PROBE_BYTES).includes('\0')) {
    return { content: '', isBinary: true }
  }
  if (result.truncated) {
    // files.read caps replies at 512KiB; page the whole file or later editable saves truncate it.
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
  const { target: runtimeTarget, worktreeId } = context
  // Paired-server chat attachments live outside worktrees; owning server reads them. Older method_not_found keeps preview fallback.
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
    if (access?.kind === 'chat-image' && runtimeTarget.kind === 'environment' && worktreeId) {
      return readHostFilePreview({
        target: runtimeTarget,
        worktreeId,
        absolutePath: filePath
      })
    }
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

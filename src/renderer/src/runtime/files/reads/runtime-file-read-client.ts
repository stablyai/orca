import type { RuntimeFilePreviewResult } from '../../../../../shared/runtime-file-contracts'
import { callRuntimeRpc } from '../../runtime-rpc-client'
import type {
  RuntimeFileDownloadResult,
  RuntimeFileOperationArgs,
  RuntimeFileReadArgs,
  RuntimeReadableFileContent
} from '../runtime-file-client-types'
import {
  assertExternalSshReadOwnership,
  canReadRelativeRuntimeFile,
  getRemoteFileArgs,
  hasRemoteRuntimeOwner,
  localAccess
} from '../runtime-file-routing'
import { toRuntimeWorktreeSelector } from '../../runtime-worktree-selector'
import { chatScratchFileAddress } from '../../runtime-chat-scratch-file-address'
import { readRemoteFileContent } from './runtime-remote-file-content'
import { isAgentSessionAttachmentStorePath } from '../../../../../shared/agent-session/agent-session-attachments'
import { decodeSvgBase64, isSvgFilePath } from '../../../../../shared/svg-document'
import type { LocalFileAccess } from '../../../../../shared/local-file-access'
import {
  isHostFileOutsideWorkspaces,
  readHostFilePreview,
  readHostFileOutsideWorkspaces
} from '../../runtime-terminal-artifact-read'
import { readRemoteFilePreview } from './runtime-paged-file-read'
import {
  downloadRemoteFileViaPreview,
  readRemoteDownloadChunk,
  remoteChunkedDownloadAvailable,
  streamDownloadedFile
} from './runtime-remote-file-download'

/** SVG opens as editable markup; hosts send it as image bytes, or as a URL if a viewer asks. */
export async function readRuntimeFileContent(
  args: RuntimeFileReadArgs
): Promise<RuntimeReadableFileContent> {
  if (!isSvgFilePath(args.filePath)) {
    return readRuntimeFileContentAsStored(args)
  }
  const result = await readRuntimeFileContentAsStored({ ...args, pageOversizedBinary: false })
  const markup = result.isBinary && result.content ? decodeSvgBase64(result.content) : null
  if (markup === null) {
    return result
  }
  return {
    content: markup,
    isBinary: false,
    ...(result.fileIdentity ? { fileIdentity: result.fileIdentity } : {})
  }
}

async function readRuntimeFileContentAsStored({
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
      ...(wakeWslDistro && !connectionId ? { wakeWslDistro } : {}),
      // A viewer reads images and PDFs by URL; baseline checks keep base64.
      ...(pageOversizedBinary && !connectionId ? { rangePreview: true } : {})
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
      expectedEnvironmentPairingRevision,
      pageOversizedBinary: pageOversizedBinary === true
    })
  }
  // A workspace path first; a chat's scratch file is the absolute path no workspace contains.
  const scratch = canReadRelativeRuntimeFile(relativePath) ? null : chatScratchFileAddress(filePath)
  const readPath = scratch?.relativePath ?? relativePath
  if (!canReadRelativeRuntimeFile(readPath)) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }

  return readRemoteFileContent(
    {
      target,
      worktree: scratch?.worktreeSelector ?? toRuntimeWorktreeSelector(worktreeId),
      relativePath: readPath
    },
    { pageOversizedBinary: pageOversizedBinary === true }
  )
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
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: context.expectedEnvironmentPairingRevision
      }
    )
  }
  if (!remoteArgs) {
    if (access?.kind === 'chat-image' && runtimeTarget.kind === 'environment' && worktreeId) {
      return readHostFilePreview({
        target: runtimeTarget,
        worktreeId,
        absolutePath: filePath,
        expectedEnvironmentPairingRevision: context.expectedEnvironmentPairingRevision
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
      relativePath: remoteArgs.relativePath,
      expectedEnvironmentPairingRevision: context.expectedEnvironmentPairingRevision
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

  return streamDownloadedFile(suggestedName, (offset) =>
    readRemoteDownloadChunk(remoteArgs, offset)
  )
}

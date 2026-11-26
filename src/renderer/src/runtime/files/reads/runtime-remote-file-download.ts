import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult
} from '../../../../../shared/file-content/runtime-file-read'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import type { RuntimeFileDownloadResult } from '../runtime-file-client-types'
import type { getRemoteFileArgs } from '../runtime-file-routing'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { captureRuntimeEnvironmentRequestRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import { showDownloadProgressToast } from '@/lib/files/download/download-progress-toast'

const REMOTE_DOWNLOAD_CHUNK_BYTES = 384 * 1024
const REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE =
  'Remote file download requires a newer Orca server. Update the headless server and try again.'

export type RemoteFileDownloadArgs = NonNullable<ReturnType<typeof getRemoteFileArgs>>

export async function remoteChunkedDownloadAvailable(
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
    // Older hosts may lack chunk downloads but still satisfy preview-sized reads.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return false
    }
    throw error
  }
}

export async function readRemoteDownloadChunk(
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

/** A workspace file on a paired host, streamed in pages, or in one reply from hosts that can't page. */
export async function downloadRemoteRuntimeFile(
  remoteArgs: RemoteFileDownloadArgs,
  suggestedName: string
): Promise<RuntimeFileDownloadResult> {
  if (!(await remoteChunkedDownloadAvailable(remoteArgs))) {
    return downloadRemoteFileViaPreview(remoteArgs, suggestedName)
  }
  return streamDownloadedFile(
    suggestedName,
    (offset) => readRemoteDownloadChunk(remoteArgs, offset),
    () =>
      callRuntimeRpc<{ size: number }>(
        remoteArgs.target,
        'files.stat',
        { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
        { timeoutMs: 15_000 }
      ).then((stat) => stat.size)
  )
}

/** A host file outside every workspace, paged through the grant the host issued for it. */
export function downloadGrantedRuntimeFile(
  grant: {
    target: RuntimeClientTarget & { kind: 'environment' }
    worktreeId: string
    absolutePath: string
    grantId: string
  },
  suggestedName: string
): Promise<RuntimeFileDownloadResult> {
  // Why: a grant id names a file only on the pairing that minted it.
  const expectedEnvironmentPairingRevision = captureRuntimeEnvironmentRequestRevision(
    grant.target.environmentId
  )
  const file = {
    worktree: toRuntimeWorktreeSelector(grant.worktreeId),
    grantId: grant.grantId,
    absolutePath: grant.absolutePath
  }
  return streamDownloadedFile(
    suggestedName,
    (offset) =>
      callRuntimeRpc<RuntimeFileReadChunkResult>(
        grant.target,
        'files.readTerminalArtifactChunk',
        { ...file, offset, length: REMOTE_DOWNLOAD_CHUNK_BYTES },
        { timeoutMs: 60_000, expectedEnvironmentPairingRevision }
      ),
    () =>
      callRuntimeRpc<{ size: number }>(grant.target, 'files.statTerminalArtifact', file, {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision
      }).then((stat) => stat.size)
  )
}

/** Appends pages to a user-chosen local file until EOF, discarding it on any failure or cancel. */
export async function streamDownloadedFile(
  suggestedName: string,
  readChunk: (offset: number) => Promise<RuntimeFileReadChunkResult>,
  readSize?: () => Promise<number>
): Promise<RuntimeFileDownloadResult> {
  // Why: stat overlaps the save dialog; a failed stat only hides the total, never blocks the download.
  const totalBytes = readSize
    ? readSize().then(
        (size) => size,
        () => null
      )
    : Promise.resolve(null)
  const download = await window.api.fs.startDownloadedFile({ suggestedName })
  if (download.canceled) {
    return download
  }

  const progress = showDownloadProgressToast(suggestedName, totalBytes)
  let finished = false
  try {
    let offset = 0
    for (;;) {
      progress.signal.throwIfAborted()
      const chunk = await readChunk(offset)
      if (chunk.bytesRead > 0) {
        await window.api.fs.appendDownloadedFileChunk({
          transferId: download.transferId,
          contentBase64: chunk.contentBase64
        })
      }
      offset += chunk.bytesRead
      progress.update(offset)
      if (chunk.eof) {
        break
      }
      if (chunk.bytesRead <= 0) {
        throw new Error('Remote download stalled before reaching EOF')
      }
    }
    // Why: a cancel during the last append would otherwise still commit the file.
    progress.signal.throwIfAborted()
    const result = await window.api.fs.finishDownloadedFile({ transferId: download.transferId })
    finished = true
    return result
  } catch (error) {
    if (progress.signal.aborted) {
      return { canceled: true }
    }
    throw error
  } finally {
    progress.close()
    if (!finished) {
      await window.api.fs.cancelDownloadedFile({ transferId: download.transferId }).catch(() => {})
    }
  }
}

export async function downloadRemoteFileViaPreview(
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
    // Legacy empty metadata-free binary means unsupported; recognized zero-byte previews remain valid.
    if (result.isBinary && !result.content && !result.isImage && !result.mimeType) {
      throw new Error(REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE)
    }
    return await window.api.fs.saveDownloadedFile({
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

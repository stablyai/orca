import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { basename } from '@/lib/path'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import type { RuntimeFileDownloadResult, RuntimeFileReadArgs } from '../runtime-file-client-types'
import {
  hostStreamsGrantedFiles,
  isRenewableGrantError,
  renewRestoredHostFileGrant,
  type TerminalArtifactGrantTarget
} from '../grants/runtime-terminal-artifact-grant'
import {
  rangeReadTarget,
  statRemoteRuntimeFile,
  type RuntimeRemoteFileAddress
} from './runtime-file-range-client'
import {
  downloadGrantedRuntimeFile,
  downloadRemoteRuntimeFile
} from './runtime-remote-file-download'

/** True when this client's OS can open the file in place; any other file is downloaded first. */
export function isClientLocalRuntimeFile(source: RuntimeFileReadArgs): boolean {
  return source.target.kind === 'local' && !source.connectionId
}

/**
 * Opens a file with this client's default app, on the route it was read from. The OS can only
 * launch a local file, so an SSH or paired-host file is downloaded to a path the user picks first.
 * False when no app opened it; a cancelled save dialog counts as handled.
 */
export async function openRuntimeFileWithDefaultApp(source: RuntimeFileReadArgs): Promise<boolean> {
  const { filePath, connectionId } = source
  const remote = rangeReadTarget(source)
  let download: RuntimeFileDownloadResult
  if (remote) {
    download = await downloadPairedHostFile(source, remote)
  } else if (connectionId) {
    download = await window.api.fs.downloadFile({ filePath, connectionId })
  } else {
    return window.api.shell.openFilePath(filePath, LOCAL_EXECUTION_HOST_ID)
  }
  if (download.canceled) {
    return true
  }
  return window.api.shell.openFilePath(download.destinationPath, LOCAL_EXECUTION_HOST_ID)
}

async function downloadPairedHostFile(
  source: RuntimeFileReadArgs,
  remote: RuntimeRemoteFileAddress
): Promise<RuntimeFileDownloadResult> {
  const name = basename(source.filePath) || source.filePath
  // rangeReadTarget refuses a paired-host read without its worktree.
  const worktreeId = source.worktreeId ?? ''
  const { target } = remote
  if (remote.grantId === undefined) {
    const { worktree: worktreeSelector, relativePath } = remote
    return downloadRemoteRuntimeFile({ target, worktreeId, worktreeSelector, relativePath }, name)
  }
  if (!(await hostStreamsGrantedFiles(target.environmentId))) {
    throw new Error(
      'Downloading this file requires a newer Orca server. Update the server and try again.'
    )
  }
  const grant = { target, worktreeId, absolutePath: remote.absolutePath }
  const grantId = await liveGrantId(remote, grant)
  return downloadGrantedRuntimeFile({ ...grant, grantId }, name)
}

/** The tab keeps the grant its read used, which the host expires; a lapsed one is renewed before the save dialog. */
async function liveGrantId(
  remote: RuntimeRemoteFileAddress & { grantId: string },
  grant: TerminalArtifactGrantTarget
): Promise<string> {
  try {
    await statRemoteRuntimeFile(remote)
    return remote.grantId
  } catch (error) {
    // Why: hosts that stream granted chunks but predate their stat can't say; the download will.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return remote.grantId
    }
    if (!isRenewableGrantError(error)) {
      throw error
    }
    return renewRestoredHostFileGrant({
      ...grant,
      expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
    })
  }
}

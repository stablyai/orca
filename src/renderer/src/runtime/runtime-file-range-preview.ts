import { filePreviewForPath } from '../../../shared/file-preview-kind'
import type { RuntimeRemoteFileAddress } from './runtime-file-range-client'
import type { RuntimeReadableFileContent } from './runtime-file-client-types'

/** A viewer that reads a URL gets the paired runtime's file streamed by range, never whole over RPC. */
export async function readRemoteRangePreview(
  remote: RuntimeRemoteFileAddress
): Promise<RuntimeReadableFileContent | null> {
  if (!filePreviewForPath(remote.relativePath)) {
    return null
  }
  // Null when this client cannot serve orca-media URLs (the paired web client).
  return window.api.fs.grantRuntimeFilePreview({
    environmentId: remote.target.environmentId,
    worktree: remote.worktree,
    relativePath: remote.relativePath,
    expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
  })
}

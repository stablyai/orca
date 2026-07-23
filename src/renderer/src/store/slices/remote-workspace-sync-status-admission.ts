import { clampUtf8TextPrefix, measureUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import type { RemoteWorkspaceSyncStatus } from './ssh'

export const REMOTE_WORKSPACE_SYNC_MESSAGE_MAX_UTF8_BYTES = 16 * 1024

export function admitRemoteWorkspaceSyncStatus(
  status: RemoteWorkspaceSyncStatus
): RemoteWorkspaceSyncStatus {
  if (typeof status.message !== 'string') {
    return status
  }
  const measured = measureUtf8ByteLength(status.message, {
    stopAfterBytes: REMOTE_WORKSPACE_SYNC_MESSAGE_MAX_UTF8_BYTES
  })
  if (!measured.exceededLimit) {
    return status
  }
  return {
    ...status,
    message: clampUtf8TextPrefix(status.message, REMOTE_WORKSPACE_SYNC_MESSAGE_MAX_UTF8_BYTES)
  }
}

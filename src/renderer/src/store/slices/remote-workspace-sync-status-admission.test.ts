import { describe, expect, it } from 'vitest'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import {
  admitRemoteWorkspaceSyncStatus,
  REMOTE_WORKSPACE_SYNC_MESSAGE_MAX_UTF8_BYTES
} from './remote-workspace-sync-status-admission'

describe('remote workspace sync status admission', () => {
  it('preserves ordinary status objects by reference', () => {
    const status = { phase: 'error' as const, message: 'Workspace sync failed' }

    expect(admitRemoteWorkspaceSyncStatus(status)).toBe(status)
  })

  it('caps a retained error message without splitting a UTF-8 code point', () => {
    const status = admitRemoteWorkspaceSyncStatus({
      phase: 'error',
      message: `${'x'.repeat(REMOTE_WORKSPACE_SYNC_MESSAGE_MAX_UTF8_BYTES - 1)}🙂tail`
    })

    expect(getUtf8ByteLength(status.message ?? '')).toBeLessThanOrEqual(
      REMOTE_WORKSPACE_SYNC_MESSAGE_MAX_UTF8_BYTES
    )
    expect(status.message?.endsWith('\ud83d')).toBe(false)
  })
})

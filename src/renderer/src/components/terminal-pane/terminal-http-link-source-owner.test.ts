import { describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

import { resolveTerminalHttpLinkSourceOwner } from './terminal-http-link-source-owner'

function transport(
  ptyId: string | null,
  runtimeEnvironmentId?: string | null,
  connectionId?: string | null
) {
  return {
    getPtyId: () => ptyId,
    getRuntimeEnvironmentId: () => runtimeEnvironmentId ?? null,
    getConnectionId: () => connectionId ?? null
  }
}

describe('resolveTerminalHttpLinkSourceOwner', () => {
  it('keeps direct SSH ownership while its PTY id is unavailable', () => {
    expect(resolveTerminalHttpLinkSourceOwner(transport(null, null, 'ssh-recovering'))).toEqual({
      kind: 'ssh',
      connectionId: 'ssh-recovering'
    })
  })

  it('prefers the transport runtime owner while its recovery PTY id is null', () => {
    expect(resolveTerminalHttpLinkSourceOwner(transport(null, 'env-recovering'))).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-recovering'
    })
  })

  it('uses the retained runtime owner for legacy ownerless remote PTY ids', () => {
    expect(
      resolveTerminalHttpLinkSourceOwner(transport('remote:legacy-handle', 'env-legacy'))
    ).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-legacy'
    })
  })

  it('falls back to the owner encoded in current remote PTY ids', () => {
    expect(
      resolveTerminalHttpLinkSourceOwner(transport(toRemoteRuntimePtyId('handle-1', 'env-encoded')))
    ).toEqual({ kind: 'runtime', runtimeEnvironmentId: 'env-encoded' })
  })

  it('does not classify an ownerless remote PTY as local without retained ownership', () => {
    expect(resolveTerminalHttpLinkSourceOwner(transport('remote:legacy-handle'))).toEqual({
      kind: 'unknown'
    })
  })
})

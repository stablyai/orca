import { describe, expect, it } from 'vitest'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import { runtimeHostConnectionDetail } from './remote-host-connection-status'

describe('runtimeHostConnectionDetail', () => {
  it('suppresses stale failures while a handshake is in flight', () => {
    expect(runtimeHostConnectionDetail(diagnostics('awaiting_ready', 0, 'old failure'))).toBe(
      undefined
    )
    expect(
      runtimeHostConnectionDetail(diagnostics('awaiting_authenticated', 0, 'old failure'))
    ).toBe(undefined)
  })

  it('shows the upcoming reconnect attempt ahead of stale failures', () => {
    expect(runtimeHostConnectionDetail(diagnostics('reconnecting', 1, 'old failure'))).toBe(
      'Attempt 2'
    )
    expect(runtimeHostConnectionDetail(diagnostics('reconnecting', 2, 'old failure'))).toBe(
      'Attempt 3'
    )
  })

  it('keeps settled connection errors visible', () => {
    expect(runtimeHostConnectionDetail(diagnostics('closed', 0, 'socket closed'))).toBe(
      'socket closed'
    )
  })
})

function diagnostics(
  state: RemoteRuntimeSharedConnectionDiagnostics['state'],
  reconnectAttempt: number,
  lastError: string | null
): RemoteRuntimeSharedConnectionDiagnostics {
  return {
    state,
    reconnectAttempt,
    lastError,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    lastConnectedAt: null,
    lastClose: null
  }
}

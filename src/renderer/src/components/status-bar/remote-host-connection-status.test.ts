import { describe, expect, it } from 'vitest'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import {
  overallDotColor,
  overallStatus,
  runtimeHostBlockedCopy,
  runtimeHostConnectionDetail,
  runtimeHostStatusForOverall
} from './remote-host-connection-status'

describe('blocked runtime hosts', () => {
  it('counts a refused host as needing attention, never as connecting', () => {
    expect(runtimeHostStatusForOverall('disconnected', 'access-revoked')).toBe('blocked')
    expect(runtimeHostStatusForOverall('connected', 'incompatible')).toBe('blocked')
    expect(runtimeHostStatusForOverall('disconnected', undefined)).toBe('disconnected')
    expect(overallStatus(['blocked'])).toBe('attention')
    expect(overallStatus(['connected', 'blocked'])).toBe('attention')
    expect(overallStatus(['blocked', 'connecting'])).toBe('connecting')
    expect(overallDotColor('attention', 0)).toBe('bg-destructive')
  })

  it('words each refusal for what the user must do', () => {
    expect(runtimeHostBlockedCopy('access-revoked').label).toBe('Access revoked')
    const update = runtimeHostBlockedCopy('incompatible', {
      kind: 'blocked',
      reason: 'server-too-old',
      clientProtocolVersion: 5,
      serverProtocolVersion: 3,
      requiredServerProtocolVersion: 4
    })
    expect(update.label).toBe('Update required')
    expect(update.detail).toContain('Update Orca on the server')
    expect(runtimeHostBlockedCopy('incompatible').detail).toBeUndefined()
  })
})

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

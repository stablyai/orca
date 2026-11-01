import { describe, expect, it } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'

import {
  getHostDetailsDescription,
  getHostDetailsSummary,
  getRuntimeServerConnectionState,
  isRuntimeServerTransportConnected,
  type RuntimeHostDetails
} from './runtime-environment-host-details'

function details(overrides: Partial<RuntimeHostDetails>): RuntimeHostDetails {
  return {
    status: 'ready',
    runtimeStatus: null,
    compatibility: null,
    error: null,
    ...overrides
  }
}

function readyTransport(
  overrides: Partial<NonNullable<RuntimeHostDetails['remoteControl']>> = {}
): NonNullable<RuntimeHostDetails['remoteControl']> {
  return {
    state: 'ready',
    pendingRequestCount: 0,
    subscriptionCount: 0,
    reconnectAttempt: 0,
    lastConnectedAt: 1,
    lastClose: null,
    lastError: null,
    ...overrides
  }
}

describe('RuntimeEnvironmentsPane host details', () => {
  it('distinguishes transport-up/runtime-down from an attached ready runtime', () => {
    // Attachment determines Disconnect and connection labels; default-server selection must not make dot/label/button disagree.
    expect(getRuntimeServerConnectionState(details({ status: 'ready' }))).toBe(
      'runtime-unavailable'
    )
    expect(isRuntimeServerTransportConnected('runtime-unavailable')).toBe(true)
    expect(
      getRuntimeServerConnectionState(
        details({
          status: 'ready',
          runtimeStatus: {
            runtimeId: 'runtime-ready',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: 1,
            liveTabCount: 0,
            liveLeafCount: 0
          }
        })
      )
    ).toBe('connected')
    expect(getHostDetailsDescription(details({ status: 'ready' }))).toContain(
      'SSH transport is connected'
    )
    expect(getHostDetailsSummary(details({ status: 'ready' }))).toBe('Orca unavailable')
    expect(getRuntimeServerConnectionState(undefined)).toBe('checking')
    expect(getRuntimeServerConnectionState(details({ status: 'loading' }))).toBe('checking')
    expect(getRuntimeServerConnectionState(details({ status: 'error', error: 'offline' }))).toBe(
      'disconnected'
    )
    expect(
      getRuntimeServerConnectionState(
        details({
          status: 'ready',
          compatibility: {
            kind: 'blocked',
            reason: 'server-too-old',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
            requiredServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
          }
        })
      )
    ).toBe('disconnected')
  })

  it('keeps a transport-ready failed status probe available in Settings', () => {
    const failedProbe = details({
      status: 'error',
      runtimeStatus: null,
      remoteControl: readyTransport(),
      error: 'runtime.status.get timed out'
    })

    expect(getHostDetailsSummary(failedProbe)).toBe('Orca unavailable')
    expect(getHostDetailsDescription(failedProbe)).toContain('SSH transport is connected')
    expect(getHostDetailsDescription(failedProbe)).toContain('runtime.status.get timed out')
    expect(getRuntimeServerConnectionState(failedProbe)).toBe('runtime-unavailable')
    expect(isRuntimeServerTransportConnected(getRuntimeServerConnectionState(failedProbe))).toBe(
      true
    )
  })

  it('keeps reconnecting and handshaking failed probes out of disconnected state', () => {
    for (const state of ['reconnecting', 'awaiting_ready', 'awaiting_authenticated'] as const) {
      expect(
        getRuntimeServerConnectionState(
          details({
            status: 'error',
            remoteControl: readyTransport({ state }),
            error: 'runtime.status.get failed'
          })
        ),
        state
      ).toBe(state === 'reconnecting' ? 'reconnecting' : 'checking')
    }
  })

  it('does not treat an errored probe with a stale compatibility verdict as connected', () => {
    expect(
      getRuntimeServerConnectionState(
        details({
          status: 'error',
          compatibility: {
            kind: 'ok',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: RUNTIME_PROTOCOL_VERSION
          },
          error: 'runtime.status.get failed'
        })
      )
    ).toBe('disconnected')
  })
})

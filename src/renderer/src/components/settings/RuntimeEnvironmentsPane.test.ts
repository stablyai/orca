import { describe, expect, it } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  evaluateHostDetails,
  getActiveServerModeDescription,
  getHostDetailsDescription,
  getHostDetailsSummary,
  getHostModelCapabilitySummary,
  getRuntimeCapabilitiesSummary,
  getRuntimeServerConnectionState,
  isRuntimeServerTransportConnected,
  isRuntimeEnvironmentRemovalBlocked,
  type RuntimeHostDetails
} from './RuntimeEnvironmentsPane'

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
  it('summarizes loading, error, compatible, and blocked hosts', () => {
    expect(getHostDetailsSummary(undefined)).toBe('Checking…')
    expect(getHostDetailsSummary(details({ status: 'error', error: 'offline' }))).toBe(
      'Status unavailable'
    )
    expect(
      getHostDetailsSummary(
        details({
          compatibility: {
            kind: 'ok',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: RUNTIME_PROTOCOL_VERSION
          }
        })
      )
    ).toBe('Compatible')
    expect(
      getHostDetailsSummary(
        details({
          compatibility: {
            kind: 'blocked',
            reason: 'server-too-old',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
            requiredServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
          }
        })
      )
    ).toBe('Update server')
    expect(
      getHostDetailsSummary(
        details({
          compatibility: {
            kind: 'blocked',
            reason: 'client-too-old',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            requiredClientProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1
          }
        })
      )
    ).toBe('Update client')
  })

  it('evaluates runtime protocol compatibility from status aliases', () => {
    expect(
      evaluateHostDetails({
        runtimeId: 'runtime-old',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        protocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
        minCompatibleMobileVersion: 0
      })
    ).toMatchObject({ kind: 'blocked', reason: 'server-too-old' })
  })

  it('explains blocked runtime compatibility with required protocol versions', () => {
    expect(
      getHostDetailsDescription(
        details({
          compatibility: {
            kind: 'blocked',
            reason: 'server-too-old',
            clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            serverProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
            requiredServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
          }
        })
      )
    ).toContain('client requires server protocol')
  })

  it('summarizes runtime capabilities by name with overflow count', () => {
    expect(
      getRuntimeCapabilitiesSummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: ['runtime.environments.v1', 'terminal.multiplex.v1']
      })
    ).toBe('runtime.environments.v1, terminal.multiplex.v1')

    expect(
      getRuntimeCapabilitiesSummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [
          'runtime.environments.v1',
          'browser.screencast.v1',
          'terminal.multiplex.v1',
          'project-host-setup.v1'
        ]
      })
    ).toBe('runtime.environments.v1, browser.screencast.v1, terminal.multiplex.v1 +1')
  })

  it('summarizes Host model capability support for version-skewed servers', () => {
    expect(
      getHostModelCapabilitySummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0
      })
    ).toBe('Host model support: checking server capabilities')

    expect(
      getHostModelCapabilitySummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [
          PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
          TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY,
          WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
        ]
      })
    ).toBe('Host model support: ready')

    expect(
      getHostModelCapabilitySummary({
        runtimeId: 'runtime',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [PROJECT_HOST_SETUP_RUNTIME_CAPABILITY]
      })
    ).toBe('Host model support: update server for task source context, workspace run context')
  })

  it('distinguishes transport-up/runtime-down from an attached ready runtime', () => {
    // Why: the row tracks attachment (reachable + ready), which exposes Disconnect.
    // Whether the host is the default *active* server is a separate concept, so it
    // must NOT change this label — otherwise the dot/label/button disagree (a host
    // showed "Available" with a grey dot yet offered Disconnect).
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

  it('explains that selecting a saved server is the explicit default Host mode', () => {
    expect(getActiveServerModeDescription(true)).toContain('Use this computer by default')
    expect(getActiveServerModeDescription(true)).toContain('browser/mobile handoff')
    expect(getActiveServerModeDescription(false)).toContain('default Host')
    expect(getActiveServerModeDescription(false)).toContain('paired Orca runtime')
  })

  it('blocks removing the active server independently of local-runtime availability', () => {
    expect(isRuntimeEnvironmentRemovalBlocked('windows-2', 'windows-2')).toBe(true)
    expect(isRuntimeEnvironmentRemovalBlocked(undefined, 'windows-2')).toBe(false)
    expect(isRuntimeEnvironmentRemovalBlocked('local', 'windows-2')).toBe(false)
  })
})

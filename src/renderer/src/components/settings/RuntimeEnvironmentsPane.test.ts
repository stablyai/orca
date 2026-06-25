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

  it('reports an attached, ready, compatible host as Connected regardless of active-ness', () => {
    // Why: the row tracks attachment (reachable + ready), which exposes Disconnect.
    // Whether the host is the default *active* server is a separate concept, so it
    // must NOT change this label — otherwise the dot/label/button disagree (a host
    // showed "Available" with a grey dot yet offered Disconnect).
    expect(getRuntimeServerConnectionState(details({ status: 'ready' }))).toBe('connected')
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

  it('explains that selecting a saved server is the explicit default Host mode', () => {
    expect(getActiveServerModeDescription(true)).toContain('Use this computer by default')
    expect(getActiveServerModeDescription(true)).toContain('browser/mobile handoff')
    expect(getActiveServerModeDescription(false)).toContain('default Host')
    expect(getActiveServerModeDescription(false)).toContain('paired Orca runtime')
  })
})

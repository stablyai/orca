import { describe, expect, it } from 'vitest'
import { MIN_COMPATIBLE_RUNTIME_SERVER_VERSION, RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import { getLocalExecutionHostLabel } from './execution-host'
import { buildExecutionHostRegistry } from './execution-host-registry'

describe('execution host registry', () => {
  it('returns only the local host for local-only state', () => {
    expect(
      buildExecutionHostRegistry({
        repos: [{ connectionId: null }],
        settings: { activeRuntimeEnvironmentId: null }
      })
    ).toEqual([
      {
        id: 'local',
        kind: 'local',
        label: getLocalExecutionHostLabel(),
        detail: 'This computer',
        health: 'local'
      }
    ])
  })

  it('includes saved and repo-derived SSH hosts with connection health', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [{ connectionId: 'repo-ssh' }],
      settings: { activeRuntimeEnvironmentId: null },
      sshTargetLabels: new Map([['saved-ssh', 'Saved SSH']]),
      sshConnectionStates: new Map([
        [
          'repo-ssh',
          {
            targetId: 'repo-ssh',
            status: 'connected',
            error: null,
            reconnectAttempt: 0
          }
        ],
        [
          'saved-ssh',
          {
            targetId: 'saved-ssh',
            status: 'auth-failed',
            error: 'Permission denied',
            reconnectAttempt: 1
          }
        ]
      ])
    })

    expect(hosts).toMatchObject([
      { id: 'local', health: 'local' },
      { id: 'ssh:saved-ssh', label: 'Saved SSH', health: 'error', connectionStatus: 'auth-failed' },
      { id: 'ssh:repo-ssh', label: 'repo-ssh', health: 'available', connectionStatus: 'connected' }
    ])
  })

  it('adds saved runtime environments and preserves compatibility state per host', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: { activeRuntimeEnvironmentId: 'old-server' },
      runtimeEnvironments: [{ id: 'builder', name: 'Linux Builder' }],
      runtimeStatusByEnvironmentId: new Map([
        [
          'builder',
          {
            appVersion: '1.8.0',
            status: {
              runtimeId: 'runtime-builder',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: ['terminal.binary-stream.v1'],
              hostPlatform: 'linux'
            }
          }
        ],
        [
          'old-server',
          {
            appVersion: '1.6.0',
            status: {
              runtimeId: 'runtime-old',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: []
            }
          }
        ]
      ])
    })

    expect(hosts).toMatchObject([
      { id: 'local', health: 'local' },
      {
        id: 'runtime:builder',
        label: 'Linux Builder',
        health: 'available',
        appVersion: '1.8.0',
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        capabilities: ['terminal.binary-stream.v1'],
        platform: 'linux',
        compatibility: { kind: 'ok' }
      },
      {
        id: 'runtime:old-server',
        label: 'old-server',
        health: 'blocked',
        appVersion: '1.6.0',
        compatibility: { kind: 'blocked', reason: 'server-too-old' }
      }
    ])
  })

  it('uses shared-control diagnostics to show reconnecting runtime host health', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: { activeRuntimeEnvironmentId: null },
      runtimeEnvironments: [{ id: 'dev-box', name: 'Dev Box' }],
      runtimeStatusByEnvironmentId: new Map([
        [
          'dev-box',
          {
            status: {
              runtimeId: 'runtime-dev',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              remoteControl: {
                state: 'reconnecting',
                pendingRequestCount: 0,
                subscriptionCount: 2,
                reconnectAttempt: 1,
                lastConnectedAt: 123,
                lastClose: { code: 1006, reason: '' },
                lastError: 'Remote Orca runtime closed the connection.'
              }
            }
          }
        ]
      ])
    })

    expect(hosts).toMatchObject([
      { id: 'local', health: 'local' },
      {
        id: 'runtime:dev-box',
        label: 'Dev Box',
        health: 'connecting',
        remoteControlState: { state: 'reconnecting', subscriptionCount: 2 }
      }
    ])
  })

  it('applies per-host display-label overrides to derived labels', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [{ connectionId: 'repo-ssh' }],
      settings: { activeRuntimeEnvironmentId: null },
      sshTargetLabels: new Map([['repo-ssh', 'Derived SSH']]),
      hostLabelOverrides: new Map([
        ['ssh:repo-ssh', 'Renamed Box'],
        ['local', 'My Laptop']
      ])
    })

    expect(hosts).toMatchObject([
      { id: 'local', label: 'My Laptop' },
      { id: 'ssh:repo-ssh', label: 'Renamed Box' }
    ])
  })

  it('keeps derived labels for hosts without an override', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [{ connectionId: 'repo-ssh' }],
      settings: { activeRuntimeEnvironmentId: null },
      sshTargetLabels: new Map([['repo-ssh', 'Derived SSH']]),
      hostLabelOverrides: new Map([['ssh:other', 'Unrelated']])
    })

    expect(hosts).toMatchObject([
      { id: 'local', label: getLocalExecutionHostLabel() },
      { id: 'ssh:repo-ssh', label: 'Derived SSH' }
    ])
  })

  it('includes runtime hosts from repo ownership but marks them disconnected without live status', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [{ connectionId: null, executionHostId: 'runtime:env-2' }],
      settings: { activeRuntimeEnvironmentId: null }
    })

    // No live status means no evidence the Orca server is reachable, so it must
    // read 'disconnected' rather than defaulting to 'available'/"Connected".
    expect(hosts).toMatchObject([
      { id: 'local', health: 'local' },
      { id: 'runtime:env-2', kind: 'runtime', label: 'env-2', health: 'disconnected' }
    ])
  })

  it('includes runtime hosts from hydrated status even when they are not focused', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: { activeRuntimeEnvironmentId: null },
      runtimeStatusByEnvironmentId: new Map([
        [
          'gpu',
          {
            appVersion: '1.8.0',
            status: {
              runtimeId: 'runtime-gpu',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: ['project-host-setup.v1'],
              hostPlatform: 'linux'
            }
          }
        ]
      ])
    })

    expect(hosts).toMatchObject([
      { id: 'local', health: 'local' },
      {
        id: 'runtime:gpu',
        kind: 'runtime',
        label: 'gpu',
        health: 'available',
        capabilities: ['project-host-setup.v1'],
        platform: 'linux'
      }
    ])
  })
})

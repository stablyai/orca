import { describe, expect, it } from 'vitest'
import { buildExecutionHostRegistry } from '../../../../../../shared/execution-host-registry'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../../../shared/protocol-version'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { canConnectAddRepoHost, canSelectAddRepoHost } from './add-repo-host-availability'

describe('Add Project host availability', () => {
  it('requires runtime reachability before allowing selection', () => {
    expect(canSelectAddRepoHost({ kind: 'runtime', health: 'available' })).toBe(true)
    expect(canSelectAddRepoHost({ kind: 'runtime', health: 'connecting' })).toBe(false)
    expect(canSelectAddRepoHost({ kind: 'runtime', health: 'disconnected' })).toBe(false)
    expect(canSelectAddRepoHost({ kind: 'runtime', health: 'error' })).toBe(false)
  })

  it('does not select a configured runtime before its first status response', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      runtimeEnvironments: [{ id: 'dev-box', name: 'Dev Box' }]
    })

    expect(hosts.filter(canSelectAddRepoHost).map((host) => host.id)).toEqual(['local'])
  })

  it.each([
    ['verified', 'connecting', ['local', 'runtime:dev-box']],
    ['verified', 'ready', ['local', 'runtime:dev-box']],
    ['checking', 'connecting', ['local']],
    ['checking', 'ready', ['local']],
    ['verified', 'disconnected', ['local']]
  ] as const)(
    'selects only reachable hosts with %s verification and %s transport during control reconnect',
    (verification, transport, expectedHostIds) => {
      const status = runtimeEnvironmentStatusFromSnapshot({
        environmentId: 'dev-box',
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 0,
        verification,
        transport,
        status: {
          runtimeId: 'runtime-dev',
          rendererGraphEpoch: 1,
          graphStatus: 'ready',
          authoritativeWindowId: 1,
          liveTabCount: 0,
          liveLeafCount: 0,
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: 1
        },
        remoteControl: {
          state: 'reconnecting',
          pendingRequestCount: 0,
          subscriptionCount: 1,
          reconnectAttempt: 1,
          lastConnectedAt: 0,
          lastClose: null,
          lastError: null
        }
      })
      const hosts = buildExecutionHostRegistry({
        repos: [],
        settings: null,
        runtimeEnvironments: [{ id: 'dev-box', name: 'Dev Box' }],
        runtimeStatusByEnvironmentId: new Map([['dev-box', status]])
      })

      expect(hosts.filter(canSelectAddRepoHost).map((host) => host.id)).toEqual(expectedHostIds)
    }
  )

  it('honors a blocked compatibility verdict even when health is available', () => {
    expect(
      canSelectAddRepoHost({
        kind: 'runtime',
        health: 'available',
        compatibility: {
          kind: 'blocked',
          reason: 'server-too-old',
          clientProtocolVersion: 3,
          serverProtocolVersion: 1,
          requiredServerProtocolVersion: 2
        }
      })
    ).toBe(false)
  })

  it('requires a managed server after SSH connects', () => {
    expect(canConnectAddRepoHost({ kind: 'ssh', health: 'connecting' })).toBe(true)
    expect(canSelectAddRepoHost({ kind: 'ssh', health: 'connecting' })).toBe(false)
    expect(canSelectAddRepoHost({ kind: 'ssh', health: 'available' })).toBe(false)
    expect(canSelectAddRepoHost({ kind: 'local', health: 'local' })).toBe(true)
    expect(canSelectAddRepoHost({ kind: 'local', health: 'connecting' })).toBe(false)
  })

  it('preserves explicit WSL startup and unavailable-host restrictions', () => {
    const host = { kind: 'runtime', health: 'disconnected', wslDistro: 'Ubuntu' } as const

    expect(canSelectAddRepoHost(host)).toBe(false)
    expect(canConnectAddRepoHost(host)).toBe(true)
    expect(canConnectAddRepoHost({ ...host, wslUnavailable: 'turned-off' })).toBe(false)
    expect(canConnectAddRepoHost({ ...host, wslUnavailable: 'server-files-missing' })).toBe(false)
  })
})

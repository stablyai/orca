import { describe, expect, it } from 'vitest'
import { buildExecutionHostRegistry } from './execution-host-registry'
import { RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import type { RemoteRuntimeSharedConnectionDiagnostics } from './remote-runtime/control/remote-runtime-shared-control-types'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from './remote-runtime/host-status/runtime-host-status'
import { RuntimeHostStatusOwner } from './remote-runtime/host-status/runtime-host-status-owner'
import type { RuntimeStatus } from './runtime-types'

const STATUS: RuntimeStatus = {
  runtimeId: 'runtime-1',
  rendererGraphEpoch: 1,
  graphStatus: 'ready',
  authoritativeWindowId: 1,
  liveTabCount: 0,
  liveLeafCount: 0,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: 1
}

function diagnostics(
  state: RemoteRuntimeSharedConnectionDiagnostics['state']
): RemoteRuntimeSharedConnectionDiagnostics {
  return {
    state,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    reconnectAttempt: 0,
    lastConnectedAt: null,
    lastClose: null,
    lastError: null
  }
}

function healthFor(snapshot: RuntimeHostStatusSnapshot): string | undefined {
  return hostFor(snapshot)?.health
}

function hostFor(snapshot: RuntimeHostStatusSnapshot) {
  return buildExecutionHostRegistry({
    repos: [],
    settings: null,
    runtimeEnvironments: [{ id: 'env-1', name: 'Server' }],
    runtimeStatusByEnvironmentId: new Map([
      ['env-1', runtimeEnvironmentStatusFromSnapshot(snapshot)]
    ])
  }).find((host) => host.id === 'runtime:env-1')
}

function ownerSnapshots(): {
  owner: RuntimeHostStatusOwner
  latest: () => RuntimeHostStatusSnapshot
} {
  const owner = new RuntimeHostStatusOwner({
    environmentId: 'env-1',
    pairingRevision: 1,
    request: () => new Promise(() => {}),
    verified: () => true,
    publish: () => {}
  })
  return { owner, latest: () => owner.read() }
}

describe('runtime host health while shared control connects (#10704)', () => {
  it('follows the status owner: fresh answer is available, a reconnect withdraws it', () => {
    const { owner, latest } = ownerSnapshots()
    owner.acceptVerified({ id: 'status.get', ok: true, result: STATUS, _meta: { runtimeId: 'r' } })
    owner.connectionChanged('connecting', diagnostics('awaiting_authenticated'))
    expect(healthFor(latest())).toBe('available')

    owner.connectionChanged('ready', diagnostics('ready'))
    expect(healthFor(latest())).toBe('available')

    owner.connectionChanged('disconnected', diagnostics('reconnecting'))
    owner.connectionChanged('connecting', diagnostics('awaiting_authenticated'))
    expect(latest().status).toEqual(STATUS)
    expect(healthFor(latest())).toBe('connecting')
    owner.dispose()
  })
})

import { describe, expect, it } from 'vitest'
import { buildExecutionHostRegistry } from './execution-host-registry'
import { RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import type { RemoteRuntimeSharedConnectionDiagnostics } from './remote-runtime-shared-control-types'
import type { RuntimeHostStatusSnapshot } from './runtime-host-status'
import { RuntimeHostStatusOwner } from './runtime-host-status-owner'
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

// Mirrors applyRuntimeHostStatusSnapshot: only a verified, unretired snapshot projects `status`.
function healthFor(snapshot: RuntimeHostStatusSnapshot): string | undefined {
  const status =
    snapshot.verification === 'verified' && !snapshot.retired && snapshot.status
      ? { ...snapshot.status, remoteControl: snapshot.remoteControl ?? undefined }
      : null
  return buildExecutionHostRegistry({
    repos: [],
    settings: null,
    runtimeEnvironments: [{ id: 'env-1', name: 'Server' }],
    runtimeStatusByEnvironmentId: new Map([
      [
        'env-1',
        {
          snapshot,
          status,
          remoteControl: snapshot.remoteControl,
          checkedAt: snapshot.checkedAt
        }
      ]
    ])
  }).find((host) => host.id === 'runtime:env-1')?.health
}

function snapshot(patch: Partial<RuntimeHostStatusSnapshot>): RuntimeHostStatusSnapshot {
  return {
    environmentId: 'env-1',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: STATUS,
    verification: 'verified',
    transport: 'connecting',
    remoteControl: diagnostics('awaiting_authenticated'),
    ...patch
  }
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
  it('is available when the status probe answered and shared control is still connecting', () => {
    expect(healthFor(snapshot({}))).toBe('available')
    expect(
      healthFor(snapshot({ transport: 'unknown', remoteControl: diagnostics('awaiting_ready') }))
    ).toBe('available')
  })

  it('stays connecting when only a status retained from the previous socket is held', () => {
    expect(healthFor(snapshot({ verification: 'unavailable' }))).toBe('connecting')
    expect(healthFor(snapshot({ verification: 'checking' }))).toBe('connecting')
    expect(healthFor(snapshot({ verification: 'checking', transport: 'ready' }))).toBe('connecting')
  })

  it('stays connecting when shared control lost its socket', () => {
    expect(
      healthFor(snapshot({ transport: 'disconnected', remoteControl: diagnostics('reconnecting') }))
    ).toBe('connecting')
  })

  it('keeps a version-blocked server blocked while shared control connects', () => {
    expect(
      healthFor(snapshot({ status: { ...STATUS, runtimeProtocolVersion: 0, protocolVersion: 0 } }))
    ).toBe('blocked')
  })

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

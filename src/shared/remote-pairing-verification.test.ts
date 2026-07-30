import { describe, expect, it } from 'vitest'
import { MIN_COMPATIBLE_RUNTIME_SERVER_VERSION, RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import { verifyRemotePairingRuntimeStatus } from './remote-pairing-verification'

function runtimeStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtimeId: 'runtime-a',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    ...overrides
  }
}

describe('verifyRemotePairingRuntimeStatus', () => {
  it('rejects malformed status responses', () => {
    expect(verifyRemotePairingRuntimeStatus(null)).toMatchObject({
      ok: false,
      kind: 'connection-interrupted'
    })
    expect(
      verifyRemotePairingRuntimeStatus(
        runtimeStatus({
          runtimeProtocolVersion: Number.NaN
        })
      )
    ).toMatchObject({ ok: false, kind: 'connection-interrupted' })
    expect(
      verifyRemotePairingRuntimeStatus({ runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION })
    ).toMatchObject({ ok: false, kind: 'connection-interrupted' })
    expect(
      verifyRemotePairingRuntimeStatus(runtimeStatus({ capabilities: 'runtime.status.compat.v1' }))
    ).toMatchObject({ ok: false, kind: 'connection-interrupted' })
    expect(verifyRemotePairingRuntimeStatus(runtimeStatus({ deviceScope: 'admin' }))).toMatchObject(
      {
        ok: false,
        kind: 'connection-interrupted'
      }
    )
  })

  it('rejects mobile-only access grants', () => {
    expect(
      verifyRemotePairingRuntimeStatus(
        runtimeStatus({
          deviceScope: 'mobile'
        })
      )
    ).toMatchObject({ ok: false, kind: 'access-link-invalid' })
  })

  it('rejects incompatible hosts', () => {
    expect(
      verifyRemotePairingRuntimeStatus(
        runtimeStatus({
          runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1
        })
      )
    ).toMatchObject({ ok: false, kind: 'protocol-incompatible' })
  })

  it('accepts a compatible runtime status', () => {
    expect(verifyRemotePairingRuntimeStatus(runtimeStatus())).toMatchObject({ ok: true })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { refreshRuntimeEnvironmentStatus } from './runtime-status-refresh'
import { stubRuntimeEnvironmentBridge } from '../../runtime/runtime-environment-bridge-fixture'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('refreshRuntimeEnvironmentStatus diagnostics', () => {
  it('publishes shared-control diagnostics from failed status probes', async () => {
    const remoteControl = diagnostics('ready')
    const getStatus = vi.fn().mockResolvedValue({
      id: 'status.get',
      ok: false,
      error: {
        code: 'runtime_unavailable',
        message: 'offline',
        data: { remoteControl }
      },
      _meta: { runtimeId: null }
    })
    stubRuntimeEnvironmentBridge({ getStatus })
    const publish = vi.fn()

    const applySnapshot = vi.fn()

    await expect(
      refreshRuntimeEnvironmentStatus('env-a', 5_000, publish, applySnapshot)
    ).resolves.toBe(false)

    expect(getStatus).toHaveBeenCalledWith({ selector: 'env-a', timeoutMs: 5_000 })
    expect(publish).toHaveBeenCalledWith({
      status: null,
      remoteControl,
      checkedAt: expect.any(Number)
    })
  })
})

function diagnostics(
  state: RemoteRuntimeSharedConnectionDiagnostics['state']
): RemoteRuntimeSharedConnectionDiagnostics {
  return {
    state,
    pendingRequestCount: 0,
    subscriptionCount: 1,
    reconnectAttempt: 0,
    lastConnectedAt: 123,
    lastClose: null,
    lastError: null
  }
}

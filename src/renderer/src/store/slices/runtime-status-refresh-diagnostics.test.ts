import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import { refreshRuntimeEnvironmentStatus } from './runtime-status-refresh'

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
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { getStatus } }
    })
    const publish = vi.fn()

    await expect(refreshRuntimeEnvironmentStatus('env-a', 5_000, publish)).resolves.toBe(false)

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

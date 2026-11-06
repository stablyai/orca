import { describe, expect, it } from 'vitest'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../../shared/remote-server-update'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { waitForReplacementRuntime } from './remote-server-restart-wait'

const support = {
  installMode: 'supervised-headless-serve',
  automatic: true,
  reason: 'available'
} as const

const install: RemoteServerUpdateInstallResult = {
  accepted: true,
  fromVersion: '1.4.0',
  targetVersion: '1.5.0',
  runtimeId: 'runtime-old'
}

const idleSnapshot: RemoteServerUpdaterSnapshot = {
  appVersion: '1.4.0',
  runtimeId: 'runtime-old',
  support,
  status: { state: 'downloaded', version: '1.5.0' }
}

function runtime(version: string, runtimeId: string): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 2,
    liveLeafCount: 1,
    capabilities: ['updater.remote-control.v1'],
    appVersion: version,
    remoteUpdateSupport: support
  }
}

describe('waitForReplacementRuntime', () => {
  it('keeps the total wait inside the budget when the status RPC eats it before the probe', async () => {
    let clock = 0
    const reconnectTimeoutMs = 20_000

    await expect(
      waitForReplacementRuntime(
        'server-1',
        {
          now: () => clock,
          wait: async (milliseconds) => {
            clock += milliseconds
          },
          // Both RPCs burn everything they are handed, so a stale budget doubles the tick.
          getUpdaterStatus: async (_environmentId, timeoutMs) => {
            clock += timeoutMs ?? 0
            return idleSnapshot
          },
          getRuntimeStatus: async (_environmentId, timeoutMs) => {
            clock += timeoutMs ?? 0
            return runtime('1.4.0', 'runtime-old')
          }
        },
        install,
        { reconnectTimeoutMs, pollIntervalMs: 500 }
      )
    ).rejects.toThrow('remote_update_reconnect_timeout')

    expect(clock).toBeLessThanOrEqual(reconnectTimeoutMs)
  })
})

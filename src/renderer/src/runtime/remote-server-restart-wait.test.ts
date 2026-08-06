import { describe, expect, it, vi } from 'vitest'
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
  it('returns the replacement process once it answers on the target version', async () => {
    let clock = 0
    let ticks = 0

    await expect(
      waitForReplacementRuntime(
        'server-1',
        {
          now: () => clock,
          wait: async (milliseconds) => {
            clock += milliseconds
          },
          getUpdaterStatus: async () => idleSnapshot,
          getRuntimeStatus: async () => {
            ticks += 1
            return ticks > 1 ? runtime('1.5.0', 'runtime-new') : runtime('1.4.0', 'runtime-old')
          }
        },
        install,
        { reconnectTimeoutMs: 1_000, pollIntervalMs: 10 }
      )
    ).resolves.toMatchObject({ runtimeId: 'runtime-new', appVersion: '1.5.0' })
  })

  it('never lets a poll RPC outlive the reconnect deadline', async () => {
    let clock = 0
    const reconnectTimeoutMs = 25_000
    const pollIntervalMs = 500

    await expect(
      waitForReplacementRuntime(
        'server-1',
        {
          now: () => clock,
          wait: async (milliseconds) => {
            clock += milliseconds
          },
          getUpdaterStatus: async () => idleSnapshot,
          // A wedged SSH link burns the whole allowance it is given before rejecting.
          getRuntimeStatus: async (_environmentId, timeoutMs) => {
            clock += timeoutMs ?? 0
            throw new Error('runtime status timed out')
          }
        },
        install,
        { reconnectTimeoutMs, pollIntervalMs }
      )
    ).rejects.toThrow('remote_update_reconnect_timeout')

    // A tick allowed its full 10s past the deadline would push this well beyond the budget.
    expect(clock).toBeLessThanOrEqual(reconnectTimeoutMs)
  })

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

  it('charges the failure probe only the budget left after the status RPC', async () => {
    let clock = 0
    const getUpdaterStatus = vi.fn(async () => idleSnapshot)

    await expect(
      waitForReplacementRuntime(
        'server-1',
        {
          now: () => clock,
          wait: async (milliseconds) => {
            clock += milliseconds
          },
          getUpdaterStatus,
          getRuntimeStatus: async () => {
            clock += 2_000
            return runtime('1.4.0', 'runtime-old')
          }
        },
        install,
        { reconnectTimeoutMs: 9_000, pollIntervalMs: 1_000 }
      )
    ).rejects.toThrow('remote_update_reconnect_timeout')

    // First probe runs on the second tick: it starts at 3s, the status RPC spends 2s more,
    // so 4s of the 9s budget is left — not the 6s the tick began with.
    expect(getUpdaterStatus).toHaveBeenNthCalledWith(1, 'server-1', 4_000)
  })

  it('bounds the failure probe by the same remaining budget', async () => {
    let clock = 0
    const getUpdaterStatus = vi.fn(async () => idleSnapshot)

    await expect(
      waitForReplacementRuntime(
        'server-1',
        {
          now: () => clock,
          wait: async (milliseconds) => {
            clock += milliseconds
          },
          getUpdaterStatus,
          getRuntimeStatus: async () => runtime('1.4.0', 'runtime-old')
        },
        install,
        { reconnectTimeoutMs: 4_000, pollIntervalMs: 1_000 }
      )
    ).rejects.toThrow('remote_update_reconnect_timeout')

    // First tick is the probe's warm-up; the second runs with 3s of the 4s budget left.
    expect(getUpdaterStatus).toHaveBeenCalledWith('server-1', 3_000)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../../shared/mobile-desktop-relay-contract'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../../shared/runtime-host-status'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { installRelayedRuntimeHostsPolling } from './relayed-runtime-hosts-polling'

function statusOf(transport: RuntimeHostStatusSnapshot['transport']) {
  return new Map([
    [
      'env-a',
      runtimeEnvironmentStatusFromSnapshot({
        environmentId: 'env-a',
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 1,
        status: {
          runtimeId: 'r',
          rendererGraphEpoch: 0,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          capabilities: [RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY]
        },
        verification: transport === 'ready' ? 'verified' : 'unavailable',
        transport
      })
    ]
  ])
}

describe('installRelayedRuntimeHostsPolling', () => {
  it('polls through the visibility interval only while a relaying server is in contact', () => {
    const store = createTestStore()
    const refresh = vi.fn(async () => {})
    store.setState({
      refreshRelayedRuntimeHosts: refresh,
      runtimeEnvironments: [
        {
          id: 'env-a',
          name: 'Studio',
          createdAt: 1,
          pairingRevision: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          preferredEndpointId: 'e',
          endpoints: []
        }
      ],
      runtimeStatusByEnvironmentId: statusOf('disconnected')
    })
    const stop = vi.fn()
    const installInterval = vi.fn((args: { run: () => void; intervalMs: number }) => {
      args.run()
      return stop
    })
    const uninstall = installRelayedRuntimeHostsPolling(store, installInterval)
    expect(installInterval).not.toHaveBeenCalled()

    store.setState({ runtimeStatusByEnvironmentId: statusOf('ready') })
    expect(installInterval).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)

    store.setState({ runtimeStatusByEnvironmentId: statusOf('disconnected') })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)

    uninstall()
  })
})

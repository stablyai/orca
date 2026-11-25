import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { readStructuredChatHostPermissionVerdict } from '@/runtime/native-chat/host-capabilities/structured-chat-host-permission'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { RuntimeHostStatusSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'

// What a paired server's chat pane gets, a shared host's must get too: the same snapshot reads the
// same, whether a paired catalog lists the host or main marks it shared.
const HOSTS = [
  {
    kind: 'paired',
    id: 'paired-env',
    catalog: [publicRuntimeEnvironment({ id: 'paired-env', pairingRevision: 3 })],
    snapshot: { pairingRevision: 3 }
  },
  {
    kind: 'shared',
    id: 'shared-env',
    catalog: [],
    snapshot: { pairingRevision: 0, sharedHost: true }
  }
] as const

let sequence = 1_000
const snapshot = (
  environmentId: string,
  patch: Partial<RuntimeHostStatusSnapshot>
): RuntimeHostStatusSnapshot => ({
  environmentId,
  pairingRevision: 0,
  sequence: sequence++,
  checkedAt: 1_700_000_000_000,
  status: {
    runtimeId: 'host-runtime',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  },
  verification: 'verified',
  transport: 'ready',
  ...patch
})
const stateOf = (environmentId: string) =>
  runtimeHostConnectionStateForEntry(
    useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  )

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each(HOSTS)('a $kind host', (host) => {
  // The outage banner shows for 'reconnecting'.
  it('reads connected from main’s snapshot, and keeps it across catalog reads', () => {
    useAppStore.getState().setRuntimeEnvironments(host.catalog)
    useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot(host.id, host.snapshot))
    expect(stateOf(host.id)).toBe('connected')
    useAppStore.getState().setRuntimeEnvironments(host.catalog)
    expect(stateOf(host.id)).toBe('connected')
  })

  it('reads reconnecting when main says its transport is down', () => {
    useAppStore.getState().setRuntimeEnvironments(host.catalog)
    useAppStore.getState().applyRuntimeHostStatusSnapshot(
      snapshot(host.id, {
        ...host.snapshot,
        transport: 'disconnected',
        verification: 'unavailable'
      })
    )
    expect(stateOf(host.id)).toBe('reconnecting')
  })

  // The composer's Send waits on this verdict.
  it('lets a chat send once the host’s status advertises per-chat permission modes', async () => {
    clearRuntimeCompatibilityCache(host.id)
    useAppStore.getState().setRuntimeEnvironments(host.catalog)
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: async (request: { method: string }) =>
            createCompatibleRuntimeStatusResponseIfNeeded(request) ?? {
              id: request.method,
              ok: false,
              error: { code: 'method_not_found', message: request.method }
            }
        }
      }
    })
    await expect(
      readStructuredChatHostPermissionVerdict(
        { kind: 'environment', environmentId: host.id },
        'claude'
      )
    ).resolves.toEqual({ kind: 'allowed' })
  })
})

it('drops a snapshot for an unlisted host that is not shared', () => {
  useAppStore.getState().setRuntimeEnvironments([])
  useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot('gone-env', {}))
  expect(useAppStore.getState().runtimeStatusByEnvironmentId.has('gone-env')).toBe(false)
})

import { beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createRuntimeStatusSlice } from './create-runtime-status-slice'
import { clearRuntimeEnvironmentConnectionGenerations as clearRuntimeEnvironmentConnectionGenerationsForTests } from './runtime-status-connection-generation'
import type { RuntimeStatusSlice } from './runtime-status-types'
import type { RuntimeHostStatusSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { setRuntimeEnvironmentCatalogRefresher } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/runtime/browser/client-hosting/restored-client-hosted-browser-host-attach', () => ({
  ensureBrowserClientHostsForRestoredPages: vi.fn(),
  ensureBrowserClientHostOnRuntimeContact: vi.fn()
}))
vi.mock('@/runtime/browser/closing/client-hosted-browser-close-intent-replay', () => ({
  replayClientHostedBrowserCloseIntents: vi.fn()
}))

beforeEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.clearAllMocks()
})
const environment = {
  id: 'env-a',
  name: 'Host',
  createdAt: 1,
  pairingRevision: 1,
  endpoints: [],
  preferredEndpointId: ''
} as unknown as PublicKnownRuntimeEnvironment
function store() {
  const value = create<RuntimeStatusSlice>()((...args) =>
    createRuntimeStatusSlice(...(args as unknown as Parameters<typeof createRuntimeStatusSlice>))
  )
  value.getState().setRuntimeEnvironments([environment])
  return value
}
function snapshot(
  sequence: number,
  patch: Partial<RuntimeHostStatusSnapshot> = {}
): RuntimeHostStatusSnapshot {
  return {
    environmentId: 'env-a',
    pairingRevision: 1,
    sequence,
    checkedAt: sequence,
    transport: 'ready',
    verification: 'verified',
    status: { runtimeId: 'rt-1' } as RuntimeStatus,
    ...patch
  }
}

it('retains disconnect ordering and rejects publications for removed or replaced pairings', () => {
  const viewer = store()
  viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(1))
  viewer
    .getState()
    .applyRuntimeHostStatusSnapshot(
      snapshot(3, { retired: true, verification: 'blocked', transport: 'disconnected' })
    )
  viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(2))
  expect(
    runtimeHostConnectionStateForEntry(viewer.getState().runtimeStatusByEnvironmentId.get('env-a'))
  ).toBe('disconnected')
  viewer.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
  viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(4))
  expect(viewer.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
  viewer.getState().setRuntimeEnvironments([])
  viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(5, { pairingRevision: 2 }))
  expect(viewer.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
})

// P1-C: main re-paired the host (a CLI rollback) and published status under the new revision.
it('re-reads the catalog when status outruns its pairing, then shows the host', async () => {
  const viewer = store()
  const refresh = vi.fn(async () => {
    viewer.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
  })
  setRuntimeEnvironmentCatalogRefresher(refresh)
  try {
    viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(1, { pairingRevision: 2 }))
    await vi.waitFor(() =>
      expect(viewer.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
        'rt-1'
      )
    )
    expect(refresh).toHaveBeenCalled()

    // A late snapshot from the replaced pairing is dropped without another re-read.
    refresh.mockClear()
    viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(2, { pairingRevision: 1 }))
    expect(refresh).not.toHaveBeenCalled()
  } finally {
    setRuntimeEnvironmentCatalogRefresher(null)
  }
})

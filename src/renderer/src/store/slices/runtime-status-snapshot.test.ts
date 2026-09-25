import { beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { toast } from 'sonner'
import {
  createRuntimeStatusSlice,
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  type RuntimeStatusSlice
} from './runtime-status'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import { ensureBrowserClientHostForRestartedRuntime } from '@/runtime/restored-client-hosted-browser-host-attach'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/runtime/restored-client-hosted-browser-host-attach', () => ({
  ensureBrowserClientHostsForRestoredPages: vi.fn(),
  ensureBrowserClientHostForRestartedRuntime: vi.fn()
}))
vi.mock('@/runtime/client-hosted-browser-close-intent-replay', () => ({
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

it('hydrates both viewers and rejects an older read after a newer publication', () => {
  for (const viewer of [store(), store()]) {
    viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(2))
    viewer
      .getState()
      .applyRuntimeHostStatusSnapshot(snapshot(1, { status: null, verification: 'unavailable' }))
    expect(viewer.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'rt-1'
    )
  }
})

it('represents failed verification honestly without manufacturing a session restart or toast', () => {
  const viewer = store()
  viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(1))
  const generation = viewer
    .getState()
    .runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration
  viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(2, { verification: 'unavailable' }))
  expect(
    runtimeHostConnectionStateForEntry(viewer.getState().runtimeStatusByEnvironmentId.get('env-a'))
  ).toBe('runtime-unavailable')
  expect(viewer.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(
    generation
  )
  viewer.getState().applyRuntimeHostStatusSnapshot(snapshot(3))
  // Regaining contact on the same runtime is neither a new connection nor a new session: the
  // generation holds so the session mirror is not rebuilt (#19647), and only the contact epoch
  // — the mirror's resubscribe trigger — moves. No restart hook, no toast.
  expect(viewer.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(
    generation
  )
  expect(viewer.getState().runtimeStatusByEnvironmentId.get('env-a')?.hostContactEpoch).toBe(1)
  expect(viewer.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
    'rt-1'
  )
  expect(ensureBrowserClientHostForRestartedRuntime).not.toHaveBeenCalled()
  expect(toast.warning).not.toHaveBeenCalled()
  const reconnectedGeneration = viewer
    .getState()
    .runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration
  viewer
    .getState()
    .applyRuntimeHostStatusSnapshot(snapshot(4, { status: { runtimeId: 'rt-2' } as RuntimeStatus }))
  // A replacement runtime id is a restart: a genuinely new connection, so the generation moves.
  expect(viewer.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(
    (reconnectedGeneration ?? 0) + 1
  )
  expect(ensureBrowserClientHostForRestartedRuntime).toHaveBeenCalled()
})

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

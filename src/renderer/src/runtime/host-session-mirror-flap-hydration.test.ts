import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  createRuntimeStatusSlice,
  getRuntimeEnvironmentConnectionGeneration,
  type RuntimeStatusSlice
} from '@/store/slices/runtime-status'
import {
  clearHostSessionMirrorHydration,
  hasHostSessionMirrorHydrated,
  markHostSessionMirrorHydrated
} from './host-session-mirror-hydration'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))

const ENVIRONMENT_ID = 'env-a'
const WORKTREE_ID = 'wt-a'
const PAIRING_REVISION = 101

function createSliceStore() {
  return create<RuntimeStatusSlice>()((...a) => ({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice creator is declared against the whole AppState; this store holds only its own slice, which is all the code under test reads.
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>))
  }))
}

function makeStatus(runtimeId: string): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

function makeSnapshot(
  sequence: number,
  patch: Partial<RuntimeHostStatusSnapshot> & Pick<RuntimeHostStatusSnapshot, 'verification'>
): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: PAIRING_REVISION,
    sequence,
    checkedAt: sequence,
    status: makeStatus('rt-1'),
    transport: 'ready',
    ...patch
  }
}

function seedEnvironment(store: ReturnType<typeof createSliceStore>): void {
  const endpointId = `ws-${ENVIRONMENT_ID}`
  store.setState({
    runtimeEnvironments: [
      {
        id: ENVIRONMENT_ID,
        name: ENVIRONMENT_ID,
        createdAt: 100,
        updatedAt: 100,
        pairingRevision: PAIRING_REVISION,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: endpointId, kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
        preferredEndpointId: endpointId
      }
    ]
  })
}

beforeEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  clearHostSessionMirrorHydration(ENVIRONMENT_ID)
  vi.stubGlobal('window', { api: {}, dispatchEvent: vi.fn() })
})

afterEach(() => {
  clearHostSessionMirrorHydration(ENVIRONMENT_ID)
  vi.unstubAllGlobals()
})

// Generation changes invalidate hydration and re-park mirrored panes. A transport flap is unverifiable, not a new connection (ssh-execution-boundary.md), so retain its verdict.
it('keeps the mirror hydrated across an unverifiable probe on the same runtime', () => {
  const store = createSliceStore()
  seedEnvironment(store)

  store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(1, { verification: 'verified' }))
  const connectedGeneration = getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)
  markHostSessionMirrorHydrated(ENVIRONMENT_ID)
  expect(hasHostSessionMirrorHydrated(ENVIRONMENT_ID, WORKTREE_ID)).toBe(true)

  store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(2, { verification: 'unavailable' }))
  expect(hasHostSessionMirrorHydrated(ENVIRONMENT_ID, WORKTREE_ID)).toBe(true)

  store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(3, { verification: 'verified' }))
  expect(getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)).toBe(connectedGeneration)
  expect(hasHostSessionMirrorHydrated(ENVIRONMENT_ID, WORKTREE_ID)).toBe(true)
})

// A replacement runtime ID is a new connection; previous PTY verdicts must invalidate.
it('discards the mirror hydration when the runtime itself was replaced', () => {
  const store = createSliceStore()
  seedEnvironment(store)

  store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(1, { verification: 'verified' }))
  markHostSessionMirrorHydrated(ENVIRONMENT_ID)
  expect(hasHostSessionMirrorHydrated(ENVIRONMENT_ID, WORKTREE_ID)).toBe(true)

  store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(2, { verification: 'unavailable' }))
  store
    .getState()
    .applyRuntimeHostStatusSnapshot(
      makeSnapshot(3, { verification: 'verified', status: makeStatus('rt-2') })
    )
  expect(hasHostSessionMirrorHydrated(ENVIRONMENT_ID, WORKTREE_ID)).toBe(false)
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { buildRuntimeSessionMirrorEnvironmentKeys } from '@/runtime/use-runtime-session-mirror-environment-key'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  createRuntimeStatusSlice,
  getRuntimeEnvironmentConnectionGeneration,
  type RuntimeStatusSlice
} from './runtime-status'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

const ENVIRONMENT_ID = 'env-a'
const PAIRING_REVISION = 101

type Store = ReturnType<typeof createSliceStore>

function createSliceStore() {
  return create<RuntimeStatusSlice>()((...a) => ({
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
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3
  } as RuntimeStatus
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

/** The mirror-subscription effect dependencies, rebuilt from the slice's current state. */
function mirrorKeys(store: Store): ReturnType<typeof buildRuntimeSessionMirrorEnvironmentKeys> {
  return buildRuntimeSessionMirrorEnvironmentKeys({
    activeRuntimeEnvironmentId: ENVIRONMENT_ID,
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironments: store.getState().runtimeEnvironments,
    runtimeStatusByEnvironmentId: store.getState().runtimeStatusByEnvironmentId
  } as Parameters<typeof buildRuntimeSessionMirrorEnvironmentKeys>[0])
}

function seedEnvironment(store: Store): void {
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
  vi.stubGlobal('window', { api: {}, dispatchEvent: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('regaining contact is its own mirror-recovery trigger', () => {
  // The mirror subscriptions are (re)installed by the effects in
  // web-session-tabs-sync/use-web-session-tabs-sync.ts. Holding the target through the outage
  // strands them unless regaining contact triggers a reinstall, but the connection generation
  // cannot be that trigger: it is the mirror's cache key, and moving it rebuilds the mirror
  // (#19647). The two live on separate values, and this suite pins each to its own edge.
  it('advances the contact epoch, not the connection generation, when a host answers again', () => {
    const store = createSliceStore()
    seedEnvironment(store)

    store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(1, { verification: 'verified' }))
    const connectedGeneration = getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)
    const connected = mirrorKeys(store)
    expect(connected.environmentKey).not.toBe('')

    store
      .getState()
      .applyRuntimeHostStatusSnapshot(makeSnapshot(2, { verification: 'unavailable' }))
    expect(getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)).toBe(connectedGeneration)
    expect(mirrorKeys(store)).toEqual(connected)

    store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(3, { verification: 'verified' }))
    expect(getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)).toBe(connectedGeneration)
    expect(mirrorKeys(store).environmentKey).toBe(connected.environmentKey)
    expect(mirrorKeys(store).resubscribeSignal).not.toBe(connected.resubscribeSignal)
  })

  it('does not advance either value while the host keeps answering', () => {
    const store = createSliceStore()
    seedEnvironment(store)

    store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(1, { verification: 'verified' }))
    const connectedGeneration = getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)
    const connected = mirrorKeys(store)

    store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(2, { verification: 'verified' }))

    expect(getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)).toBe(connectedGeneration)
    expect(mirrorKeys(store)).toEqual(connected)
  })

  it('leaves a first publication with no prior entry on its original generation', () => {
    // Regression (#19241): a first contact is not a reconnect, or the generation fence
    // retires worktree scans already in flight against that same connection.
    const store = createSliceStore()
    seedEnvironment(store)
    const before = getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)

    store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(1, { verification: 'verified' }))

    expect(getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)).toBe(before)
  })

  it('advances the generation when the runtime restarted during the outage', () => {
    const store = createSliceStore()
    seedEnvironment(store)

    store.getState().applyRuntimeHostStatusSnapshot(makeSnapshot(1, { verification: 'verified' }))
    const connectedGeneration = getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)

    store
      .getState()
      .applyRuntimeHostStatusSnapshot(makeSnapshot(2, { verification: 'unavailable' }))
    store
      .getState()
      .applyRuntimeHostStatusSnapshot(
        makeSnapshot(3, { verification: 'verified', status: makeStatus('rt-2') })
      )

    expect(getRuntimeEnvironmentConnectionGeneration(ENVIRONMENT_ID)).toBe(connectedGeneration + 1)
  })
})

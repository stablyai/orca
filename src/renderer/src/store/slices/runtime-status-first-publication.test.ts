import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  createRuntimeStatusSlice,
  getRuntimeEnvironmentConnectionGeneration,
  type RuntimeStatusSlice
} from './runtime-status'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

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

beforeEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.stubGlobal('window', { api: {}, dispatchEvent: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('first runtime status publication', () => {
  it('does not advance the connection generation when no entry existed', () => {
    // Regression (#19241): the first status for a paired environment counted as a
    // connection change, so the generation fence retired worktree scans already in
    // flight against that same connection. Those repos stayed absent from the sidebar
    // until an unrelated refresh happened to run.
    const store = createSliceStore()
    const before = getRuntimeEnvironmentConnectionGeneration('env-a')
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')).toBeUndefined()

    store
      .getState()
      .setRuntimeEnvironmentStatus('env-a', { status: makeStatus('runtime-a'), checkedAt: 1 })

    expect(getRuntimeEnvironmentConnectionGeneration('env-a')).toBe(before)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(
      before
    )
  })

  it('still advances when a recorded-unreachable host comes back', () => {
    // The other reading of the old `previous?.status == null`: this one IS a reconnect.
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })
    const before = getRuntimeEnvironmentConnectionGeneration('env-a')

    store
      .getState()
      .setRuntimeEnvironmentStatus('env-a', { status: makeStatus('runtime-a'), checkedAt: 2 })

    expect(getRuntimeEnvironmentConnectionGeneration('env-a')).toBe(before + 1)
  })
})

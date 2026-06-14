import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { createRuntimeStatusSlice, type RuntimeStatusSlice } from './runtime-status'

function createSliceStore() {
  return create<RuntimeStatusSlice>()((...a) => ({
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>))
  }))
}

function makeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'rt',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3,
    ...overrides
  } as RuntimeStatus
}

describe('runtime-status slice', () => {
  it('starts with an empty map', () => {
    const store = createSliceStore()
    expect(store.getState().runtimeEnvironments).toEqual([])
    expect(store.getState().runtimeStatusByEnvironmentId.size).toBe(0)
  })

  it('stores saved runtime environments and trims stale statuses', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('drop', { status: makeStatus(), checkedAt: 1 })

    store.getState().setRuntimeEnvironments([
      {
        id: 'keep',
        name: 'Dev Box',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-keep', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
        preferredEndpointId: 'ws-keep'
      }
    ])

    expect(store.getState().runtimeEnvironments.map((environment) => environment.name)).toEqual([
      'Dev Box'
    ])
    expect(store.getState().runtimeStatusByEnvironmentId.has('keep')).toBe(true)
    expect(store.getState().runtimeStatusByEnvironmentId.has('drop')).toBe(false)
  })

  it('merges per environment id and produces a new map reference', () => {
    const store = createSliceStore()
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus(),
      checkedAt: 1
    })
    const afterFirst = store.getState().runtimeStatusByEnvironmentId
    expect(afterFirst).not.toBe(before)
    expect(afterFirst.get('env-a')?.checkedAt).toBe(1)

    store.getState().setRuntimeEnvironmentStatus('env-b', {
      status: null,
      checkedAt: 2
    })
    const afterSecond = store.getState().runtimeStatusByEnvironmentId
    expect(afterSecond.size).toBe(2)
    expect(afterSecond.get('env-a')?.checkedAt).toBe(1)
    expect(afterSecond.get('env-b')?.status).toBeNull()
  })

  it('overwrites the prior entry for the same id', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 5 })

    const map = store.getState().runtimeStatusByEnvironmentId
    expect(map.size).toBe(1)
    expect(map.get('env-a')).toEqual({ status: null, checkedAt: 5 })
  })

  it('clears a single environment entry', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-b', { status: makeStatus(), checkedAt: 1 })

    store.getState().clearRuntimeEnvironmentStatus('env-a')
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-b')).toBe(true)
  })

  it('no-ops clearing an unknown id without creating a new reference', () => {
    const store = createSliceStore()
    const before = store.getState().runtimeStatusByEnvironmentId
    store.getState().clearRuntimeEnvironmentStatus('missing')
    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
  })

  it('retains only saved environment ids', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('drop', { status: makeStatus(), checkedAt: 1 })

    store.getState().retainRuntimeEnvironmentStatuses(['keep'])
    const map = store.getState().runtimeStatusByEnvironmentId
    expect(map.has('keep')).toBe(true)
    expect(map.has('drop')).toBe(false)
  })

  it('no-ops retain when nothing is dropped', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().retainRuntimeEnvironmentStatuses(['keep', 'unrelated'])
    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
  })
})

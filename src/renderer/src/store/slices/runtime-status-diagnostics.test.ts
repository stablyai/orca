import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { createRuntimeStatusSlice, type RuntimeStatusSlice } from './runtime-status'

function makeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'runtime-a',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 3,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3,
    capabilities: ['browser.screencast.v1'],
    ...overrides
  } as RuntimeStatus
}

function createSliceStore() {
  return create<RuntimeStatusSlice>()((...a) => ({
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>))
  }))
}

describe('runtime-status diagnostics', () => {
  it('merges transport diagnostics into the complete status and fences stale pushes', () => {
    const store = createSliceStore()
    const status = makeStatus({
      capabilities: ['browser.screencast.v1', REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
    })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status, checkedAt: 1 })
    const closed = {
      state: 'closed' as const,
      pendingRequestCount: 0,
      subscriptionCount: 1,
      reconnectAttempt: 2,
      lastConnectedAt: 1,
      lastClose: { code: 1006, reason: 'network' },
      lastError: 'connection lost'
    }
    store.getState().publishRuntimeEnvironmentDiagnostics({
      environmentId: 'env-a',
      transportGeneration: 3,
      diagnostics: closed
    })
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toMatchObject({
      runtimeId: 'runtime-a',
      capabilities: expect.arrayContaining([
        'browser.screencast.v1',
        REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY
      ]),
      liveTabCount: 3,
      remoteControl: closed
    })
    store.getState().publishRuntimeEnvironmentDiagnostics({
      environmentId: 'env-a',
      transportGeneration: 2,
      diagnostics: { ...closed, state: 'ready' }
    })
    expect(
      store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.remoteControl?.state
    ).toBe('closed')
  })

  it('ignores diagnostics after the latest status drops shared-control support', () => {
    const store = createSliceStore()
    const status = makeStatus({ capabilities: [] })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status, checkedAt: 1 })

    store.getState().publishRuntimeEnvironmentDiagnostics({
      environmentId: 'env-a',
      transportGeneration: 3,
      diagnostics: {
        state: 'reconnecting',
        pendingRequestCount: 0,
        subscriptionCount: 1,
        reconnectAttempt: 2,
        lastConnectedAt: 1,
        lastClose: { code: 1006, reason: 'network' },
        lastError: 'connection lost'
      }
    })

    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toBe(status)
  })
})

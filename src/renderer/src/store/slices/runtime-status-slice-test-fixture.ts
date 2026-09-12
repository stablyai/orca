import { vi } from 'vitest'
import { create } from 'zustand'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { createRuntimeStatusSlice, type RuntimeStatusSlice } from './runtime-status'

export function createSliceStore() {
  return create<RuntimeStatusSlice>()((...a) => ({
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>))
  }))
}

export function makeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
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

export function makeEnvironment(
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-a',
    name: 'Dev Box',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
    preferredEndpointId: 'ws-a',
    ...overrides
  }
}

type StubbedRuntimeEnvironmentApi = {
  getStatus: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
}

export function stubRuntimeEnvironmentApi({
  getStatus = vi.fn(),
  list = vi.fn()
}: Partial<StubbedRuntimeEnvironmentApi>): StubbedRuntimeEnvironmentApi {
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        getStatus,
        list
      }
    }
  })
  return { getStatus, list }
}

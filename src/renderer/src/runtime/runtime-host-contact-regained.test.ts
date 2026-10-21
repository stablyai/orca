import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../../shared/runtime-types'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const { createRuntimeStatusSlice } = await import('@/store/slices/runtime-status')
  type Slice = ReturnType<typeof createRuntimeStatusSlice>
  return {
    useAppStore: create<Slice>()((...a) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice reads only its own fields.
      createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>))
    )
  }
})

import { useAppStore } from '@/store'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

function makeStatus(runtimeId: string): RuntimeStatus {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture carries only the fields the slice reads.
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

let lastVerified: RuntimeStatus | null = null

// As the host-status snapshot does: an outage keeps the last verified status, so a same-runtime
// return moves only the contact epoch, not the connection generation.
function publish(status: RuntimeStatus | null, checkedAt: number): void {
  lastVerified = status ?? lastVerified
  useAppStore.getState().setRuntimeEnvironmentStatus('env-a', {
    status,
    checkedAt,
    snapshot: {
      environmentId: 'env-a',
      pairingRevision: 1,
      sequence: checkedAt,
      checkedAt,
      status: lastVerified,
      verification: status ? 'verified' : 'unavailable',
      transport: status ? 'ready' : 'disconnected'
    }
  })
}

beforeEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.stubGlobal('window', { api: {}, dispatchEvent: vi.fn() })
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  lastVerified = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('subscribeRuntimeHostContactRegained', () => {
  it('fires when the runtime answers again after an outage, and not while it stays down', () => {
    publish(makeStatus('runtime-a'), 1)
    const listener = vi.fn()
    const stop = subscribeRuntimeHostContactRegained('env-a', listener)

    publish(null, 2)
    publish(null, 3)
    expect(listener).not.toHaveBeenCalled()

    // Same runtime back: only the contact epoch moves.
    const generation = useAppStore
      .getState()
      .runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration
    publish(makeStatus('runtime-a'), 4)
    expect(
      useAppStore.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration
    ).toBe(generation)
    expect(listener).toHaveBeenCalledTimes(1)
    publish(makeStatus('runtime-a'), 5)
    expect(listener).toHaveBeenCalledTimes(1)

    // A restarted runtime: the connection generation moves.
    publish(makeStatus('runtime-b'), 6)
    expect(listener).toHaveBeenCalledTimes(2)

    stop()
    publish(null, 7)
    publish(makeStatus('runtime-b'), 8)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('ignores other environments', () => {
    publish(makeStatus('runtime-a'), 1)
    const listener = vi.fn()
    const stop = subscribeRuntimeHostContactRegained('env-b', listener)
    publish(null, 2)
    publish(makeStatus('runtime-a'), 3)
    expect(listener).not.toHaveBeenCalled()
    stop()
  })
})

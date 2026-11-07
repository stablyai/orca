import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('@/store/index', async () => {
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

import { useAppStore } from '@/store/index'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'
import {
  forgetStructuredSessionSelection,
  registerStructuredSelectionCatalogStore
} from '@/lib/agent-session/options/structured-agent-session-selection-controller'

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

// Same-runtime return retains verified status and advances contact epoch, not connection generation.
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

let restoreCatalog: () => void
beforeEach(() => {
  restoreCatalog = registerStructuredSelectionCatalogStore({
    read: useAppStore.getState,
    subscribe: useAppStore.subscribe
  })
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.stubGlobal('window', { api: {}, dispatchEvent: vi.fn() })
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  lastVerified = null
})

afterEach(() => {
  forgetStructuredSessionSelection('continuity')
  forgetStructuredSessionSelection('keyless')
  restoreCatalog()
  vi.unstubAllGlobals()
})

describe('subscribeRuntimeHostContactRegained', () => {
  it('fires when the runtime answers again after an outage, and not while it stays down', () => {
    publish(makeStatus('runtime-a'), 1)
    let phase = 'down'
    const observed: string[] = []
    const stop = subscribeRuntimeHostContactRegained('env-a', () => observed.push(phase))

    publish(null, 2)
    publish(null, 3)
    expect(observed).toEqual([])

    phase = 'same-runtime-return'
    publish(makeStatus('runtime-a'), 4)
    expect(observed).toEqual(['same-runtime-return'])
    phase = 'unchanged'
    publish(makeStatus('runtime-a'), 5)
    expect(observed).toEqual(['same-runtime-return'])

    phase = 'restart'
    publish(makeStatus('runtime-b'), 6)
    expect(observed).toEqual(['same-runtime-return', 'restart'])

    stop()
    phase = 'disposed'
    publish(null, 7)
    publish(makeStatus('runtime-b'), 8)
    expect(observed).toEqual(['same-runtime-return', 'restart'])
  })
})

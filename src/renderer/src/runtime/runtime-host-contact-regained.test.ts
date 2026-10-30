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
import {
  structuredSessionSelectionController,
  forgetStructuredSessionSelection,
  registerStructuredSelectionCatalogStore
} from '@/lib/structured-agent-session-selection-controller'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'

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

const env = (revision: number, key?: string): PublicKnownRuntimeEnvironment => ({
  id: 'env-a',
  name: 'managed',
  createdAt: 1,
  updatedAt: revision,
  pairingRevision: revision,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'loopback',
  connectionDependency: 'ssh-tunnel',
  hostKeyFingerprint: key,
  orcadDeployment: {
    sshTargetId: 'box',
    sshTargetGeneration: 1,
    localPort: 46768,
    remotePort: 6768
  }
})

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

  it('wakes a parked owner when a pending managed pairing proves its key without another revision', async () => {
    useAppStore.getState().setRuntimeEnvironments([env(1, 'key-A')])
    const target = { kind: 'environment', environmentId: 'env-a' } as const
    const owner = structuredSessionSelectionController(target, 'continuity', 'codex')
    const held = owner.issue('model', 'gpt-5.4', null)
    const listener = vi.fn()
    const stop = subscribeRuntimeHostContactRegained('env-a', listener)
    useAppStore.getState().setRuntimeEnvironments([env(2)])
    expect(structuredSessionSelectionController(target, 'continuity', 'codex')).toBe(owner)
    expect(held.outcome).toBeUndefined()
    const pendingWakes = listener.mock.calls.length
    useAppStore.getState().setRuntimeEnvironments([env(2, 'key-A')])
    expect(listener).toHaveBeenCalledTimes(pendingWakes + 1)
    useAppStore.getState().setRuntimeEnvironments([env(2, 'key-A')])
    expect(listener).toHaveBeenCalledTimes(pendingWakes + 1)
    useAppStore.getState().setRuntimeEnvironments([env(3)])
    expect(structuredSessionSelectionController(target, 'continuity', 'codex')).toBe(owner)
    expect(held.outcome).toBeUndefined()
    useAppStore.getState().setRuntimeEnvironments([env(3, 'key-A')])
    const send = vi.fn().mockResolvedValue('current')
    await owner.request(send)
    expect(send).toHaveBeenCalledWith({ expectedEnvironmentPairingRevision: 3 })
    useAppStore.getState().setRuntimeEnvironments([env(4, 'different')])
    expect(held.outcome).toEqual({ kind: 'superseded' })
    expect(structuredSessionSelectionController(target, 'continuity', 'codex')).not.toBe(owner)
    stop()
    forgetStructuredSessionSelection('continuity')
  })
})

it('ends supported keyless SSH affinity when the classifier supplies neither proof nor pending', async () => {
  useAppStore.getState().setRuntimeEnvironments([env(1)])
  const target = { kind: 'environment', environmentId: 'env-a' } as const
  const owner = structuredSessionSelectionController(target, 'keyless', 'codex')
  const held = owner.issue('model', 'gpt-5.4', null)
  useAppStore.getState().setRuntimeEnvironments([env(2)])
  await expect(held.result).resolves.toEqual({ kind: 'superseded' })
  const send = vi.fn().mockResolvedValue('current')
  await expect(owner.request(send)).rejects.toThrow('retired')
  expect(send).not.toHaveBeenCalled()
  const fresh = structuredSessionSelectionController(target, 'keyless', 'codex')
  expect(fresh).not.toBe(owner)
  await expect(fresh.request(send)).resolves.toBe('current')
  expect(send).toHaveBeenCalledWith({ expectedEnvironmentPairingRevision: 2 })
  forgetStructuredSessionSelection('keyless')
})

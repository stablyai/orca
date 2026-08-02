/**
 * Memory-leak regression: runtime detected-agent caches must be evicted when a
 * runtime environment is removed.
 *
 * `runtimeDetectedAgentIds` and `isDetectingRuntimeAgents` are keyed by runtime
 * environmentId and gain an entry per environment that opens its tab-bar launch
 * menu. The only removal action (`clearRuntimeDetectedAgents`) had no production
 * caller, so removed environments leaked their entries for the renderer session.
 * `setRuntimeEnvironments` now prunes them to the surviving environment set.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// Controllable runtime RPC so a detect can be held in flight, then resolved or
// rejected after the environment is pruned.
const rpcControl = vi.hoisted(() => {
  const deferreds: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []
  return {
    deferreds,
    callRuntimeRpc: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          deferreds.push({ resolve, reject })
        })
    )
  }
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return { ...actual, callRuntimeRpc: rpcControl.callRuntimeRpc }
})

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore } from './store-test-helpers'

function env(id: string): PublicKnownRuntimeEnvironment {
  return { id } as unknown as PublicKnownRuntimeEnvironment
}

describe('runtime detected-agents pruned on environment removal (leak regression)', () => {
  it('drops detected-agent caches for environments that no longer exist', () => {
    const store = createTestStore()
    store.setState({
      runtimeDetectedAgentIds: { 'env-1': [], 'env-2': [] },
      isDetectingRuntimeAgents: { 'env-1': false, 'env-2': true }
    })

    // env-2 is removed from the runtime environment list.
    store.getState().setRuntimeEnvironments([env('env-1')])

    const s = store.getState()
    expect(s.runtimeDetectedAgentIds).not.toHaveProperty('env-2')
    expect(s.isDetectingRuntimeAgents).not.toHaveProperty('env-2')
    // Surviving environment is preserved.
    expect(s.runtimeDetectedAgentIds).toHaveProperty('env-1')
    expect(s.isDetectingRuntimeAgents['env-1']).toBe(false)
  })

  it('retainRuntimeDetectedAgents keeps only the listed environments', () => {
    const store = createTestStore()
    store.setState({
      runtimeDetectedAgentIds: { a: [], b: [], c: [] },
      isDetectingRuntimeAgents: { a: false, b: false, c: false }
    })

    store.getState().retainRuntimeDetectedAgents(['b'])

    const s = store.getState()
    expect(Object.keys(s.runtimeDetectedAgentIds)).toEqual(['b'])
    expect(Object.keys(s.isDetectingRuntimeAgents)).toEqual(['b'])
  })
})

describe('detect resolving after the environment was pruned does not re-leak', () => {
  beforeEach(() => {
    rpcControl.deferreds.length = 0
    rpcControl.callRuntimeRpc.mockClear()
  })

  it('does not re-add an entry when an in-flight detect REJECTS after pruning', async () => {
    const store = createTestStore()
    const pending = store.getState().ensureRuntimeDetectedAgents('env-1')
    expect(store.getState().isDetectingRuntimeAgents['env-1']).toBe(true)
    expect(rpcControl.deferreds).toHaveLength(1)

    // Environment removed while the detect is still in flight.
    store.getState().retainRuntimeDetectedAgents([])
    expect(store.getState().isDetectingRuntimeAgents).not.toHaveProperty('env-1')

    // The probe then fails — the unguarded .catch would re-add isDetecting=false.
    rpcControl.deferreds[0].reject(new Error('disconnected'))
    await pending

    expect(store.getState().isDetectingRuntimeAgents).not.toHaveProperty('env-1')
    expect(store.getState().runtimeDetectedAgentIds).not.toHaveProperty('env-1')
  })

  it('does not re-add an entry when an in-flight detect RESOLVES after pruning', async () => {
    const store = createTestStore()
    const pending = store.getState().ensureRuntimeDetectedAgents('env-2')
    expect(rpcControl.deferreds).toHaveLength(1)

    store.getState().retainRuntimeDetectedAgents([])
    expect(store.getState().runtimeDetectedAgentIds).not.toHaveProperty('env-2')

    rpcControl.deferreds[0].resolve([])
    await pending

    expect(store.getState().runtimeDetectedAgentIds).not.toHaveProperty('env-2')
    expect(store.getState().isDetectingRuntimeAgents).not.toHaveProperty('env-2')
  })
})

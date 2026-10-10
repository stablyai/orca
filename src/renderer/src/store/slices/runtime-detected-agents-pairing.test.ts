import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: rpc.call
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal API stub for the store under test
globalThis.window = { api: {} }
import { createTestStore } from './store-test-helpers'

function environment(pairingRevision: number): PublicKnownRuntimeEnvironment {
  return {
    id: 'detection-peer',
    name: 'Paired host',
    createdAt: 1,
    updatedAt: pairingRevision,
    pairingRevision,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: 'host'
  }
}

function deferredAgents() {
  let resolve!: (agents: TuiAgent[]) => void
  const promise = new Promise<TuiAgent[]>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

beforeEach(() => {
  rpc.call.mockReset()
  createTestStore().getState().clearRuntimeDetectedAgents('detection-peer')
})

describe('runtime detection pairing ownership', () => {
  it('refuses detection and refresh captured against a retired pairing', async () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments([environment(2)])
    await expect(
      store.getState().ensureRuntimeDetectedAgents('detection-peer', undefined, 1)
    ).resolves.toEqual([])
    await expect(
      store.getState().refreshRuntimeDetectedAgents('detection-peer', undefined, 1)
    ).resolves.toEqual([])
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('does not retarget an old refresh fallback to the replacement pairing', async () => {
    const store = createTestStore()
    let failOld!: (error: Error) => void
    rpc.call.mockReturnValueOnce(
      new Promise((_, reject) => {
        failOld = reject
      })
    )
    store.getState().setRuntimeEnvironments([environment(1)])
    const old = store.getState().refreshRuntimeDetectedAgents('detection-peer', undefined, 1)
    store.getState().setRuntimeEnvironments([environment(2)])
    rpc.call.mockResolvedValueOnce(['codex'])
    await store.getState().ensureRuntimeDetectedAgents('detection-peer', undefined, 2)
    failOld(
      new RuntimeRpcCallError({
        id: 'refresh',
        ok: false,
        error: { code: 'method_not_found', message: 'Unsupported method' }
      })
    )
    await expect(old).resolves.toEqual([])
    expect(rpc.call).toHaveBeenCalledTimes(2)
    expect(store.getState().runtimeDetectedAgentIds['detection-peer']).toEqual(['codex'])
  })

  it.each(['detect', 'refresh'] as const)(
    'retires cached %s results when the environment is re-paired',
    async (operation) => {
      const store = createTestStore()
      store.getState().setRuntimeEnvironments([environment(1)])
      rpc.call.mockResolvedValueOnce(operation === 'detect' ? ['claude'] : { agents: ['claude'] })
      await (operation === 'detect'
        ? store.getState().ensureRuntimeDetectedAgents('detection-peer')
        : store.getState().refreshRuntimeDetectedAgents('detection-peer'))
      store.getState().setRuntimeEnvironments([environment(2)])
      expect(store.getState().runtimeDetectedAgentIds['detection-peer']).toBeUndefined()
      rpc.call.mockResolvedValueOnce(['codex'])
      await expect(store.getState().ensureRuntimeDetectedAgents('detection-peer')).resolves.toEqual(
        ['codex']
      )
      expect(rpc.call).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['detect', true],
    ['detect', false],
    ['refresh', true],
    ['refresh', false]
  ] as const)('fences old %s replies finishing first=%s', async (operation, oldFirst) => {
    const store = createTestStore()
    const oldReply = deferredAgents()
    const replacementReply = deferredAgents()
    rpc.call.mockReturnValueOnce(
      operation === 'detect' ? oldReply.promise : oldReply.promise.then((agents) => ({ agents }))
    )
    rpc.call.mockReturnValueOnce(replacementReply.promise)
    store.getState().setRuntimeEnvironments([environment(1)])
    const old =
      operation === 'detect'
        ? store.getState().ensureRuntimeDetectedAgents('detection-peer')
        : store.getState().refreshRuntimeDetectedAgents('detection-peer')
    store.getState().setRuntimeEnvironments([environment(2)])
    const current = store.getState().ensureRuntimeDetectedAgents('detection-peer')
    expect(current).not.toBe(old)
    expect(rpc.call).toHaveBeenCalledTimes(2)
    if (oldFirst) {
      oldReply.resolve(['claude'])
      await expect(old).resolves.toEqual([])
      expect(store.getState().runtimeDetectedAgentIds['detection-peer']).toBeNull()
      expect(store.getState().isDetectingRuntimeAgents['detection-peer']).toBe(true)
    }
    replacementReply.resolve(['codex'])
    await expect(current).resolves.toEqual(['codex'])
    if (!oldFirst) {
      oldReply.resolve(['claude'])
      await expect(old).resolves.toEqual([])
    }
    expect(store.getState().runtimeDetectedAgentIds['detection-peer']).toEqual(['codex'])
  })
})

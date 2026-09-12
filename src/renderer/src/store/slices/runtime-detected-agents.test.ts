/**
 * Regression: a runtime (`orca serve`) host that already reported agents must be
 * re-probed when a new launch surface mounts. `ensureRuntimeDetectedAgents`
 * short-circuits any non-empty cached list, so without the `force` escape hatch
 * the mount-time retry in `useDetectedAgents` was a no-op and a CLI installed
 * after the first detection stayed invisible until the Orca client restarted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import type { AppState } from '../types'
import { _getRuntimeDetectPromiseCountForTest } from './runtime-detected-agents'
import { createTestStore } from './store-test-helpers'

const runtimeRpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return { ...actual, callRuntimeRpc: runtimeRpc.callRuntimeRpc }
})

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

describe('ensureRuntimeDetectedAgents force', () => {
  beforeEach(() => {
    runtimeRpc.callRuntimeRpc.mockReset()
  })

  it('re-probes a cached non-empty list only when forced', async () => {
    const store = createTestStore()
    runtimeRpc.callRuntimeRpc.mockResolvedValueOnce(['claude'])

    await expect(store.getState().ensureRuntimeDetectedAgents('env-1')).resolves.toEqual(['claude'])
    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledTimes(1)

    // Unforced callers keep the cached list — store churn must not re-probe.
    await expect(store.getState().ensureRuntimeDetectedAgents('env-1')).resolves.toEqual(['claude'])
    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledTimes(1)

    // A freshly mounted launch surface forces one probe, so a CLI installed
    // after the first detection appears without a client restart.
    runtimeRpc.callRuntimeRpc.mockResolvedValueOnce(['claude', 'devin'])
    await expect(
      store.getState().ensureRuntimeDetectedAgents('env-1', { force: true })
    ).resolves.toEqual(['claude', 'devin'])

    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(runtimeRpc.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'preflight.detectAgents'
    )
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['claude', 'devin'])
  })

  it('collapses concurrent forced mounts onto a single probe', async () => {
    const store = createTestStore()
    store.setState({ runtimeDetectedAgentIds: { 'env-1': ['claude'] } } as Partial<AppState>)

    let resolveDetect: (value: unknown) => void = () => {}
    runtimeRpc.callRuntimeRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetect = resolve
        })
    )

    const first = store.getState().ensureRuntimeDetectedAgents('env-1', { force: true })
    const second = store.getState().ensureRuntimeDetectedAgents('env-1', { force: true })

    expect(_getRuntimeDetectPromiseCountForTest()).toBe(1)
    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledTimes(1)

    resolveDetect(['claude', 'devin'])
    await expect(first).resolves.toEqual(['claude', 'devin'])
    await expect(second).resolves.toEqual(['claude', 'devin'])
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['claude', 'devin'])
  })

  it('keeps the last known list when a forced probe fails', async () => {
    const store = createTestStore()
    store.setState({ runtimeDetectedAgentIds: { 'env-1': ['claude'] } } as Partial<AppState>)
    runtimeRpc.callRuntimeRpc.mockRejectedValueOnce(new Error('runtime disconnected'))

    await expect(
      store.getState().ensureRuntimeDetectedAgents('env-1', { force: true })
    ).resolves.toEqual([])

    // Why: a transient failure on the mount-time probe must not empty the picker.
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['claude'])
    expect(store.getState().isDetectingRuntimeAgents['env-1']).toBe(false)
  })
})

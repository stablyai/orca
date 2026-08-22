import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentSubscribe = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: runtimeEnvironmentCall,
        subscribe: runtimeEnvironmentSubscribe
      }
    }
  })
})

describe('runtime RPC client cancellation', () => {
  it('aborts a cold compatibility wait without cancelling its shared probe', async () => {
    let resolveStatus!: () => void
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        return new Promise((resolve) => {
          resolveStatus = () =>
            resolve({
              id: 'status',
              ok: true,
              result: {
                runtimeId: 'remote-runtime',
                graphStatus: 'ready',
                runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
              },
              _meta: { runtimeId: 'remote-runtime' }
            })
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
    const target = { kind: 'environment', environmentId: 'env-cold-abort' } as const
    const controller = new AbortController()

    const request = callRuntimeRpc(target, 'browser.eval', {}, { signal: controller.signal })
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual(['status.get'])

    resolveStatus()
    await expect(callRuntimeRpc(target, 'repo.list')).resolves.toEqual({ ok: true })
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'repo.list'
    ])
  })

  it('unsubscribes when cancellation wins before subscription admission resolves', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'remote-runtime',
        graphStatus: 'ready',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    let resolveSubscription!: (subscription: { unsubscribe: () => void }) => void
    const unsubscribe = vi.fn()
    runtimeEnvironmentSubscribe.mockImplementation((_args, callbacks) => {
      const handle = { unsubscribe }
      callbacks.onSubscriptionStart?.(handle)
      return new Promise((resolve) => {
        resolveSubscription = () => resolve(handle)
      })
    })
    const controller = new AbortController()
    const request = callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-pending-abort' },
      'browser.eval',
      {},
      { signal: controller.signal }
    )

    await vi.waitFor(() => expect(runtimeEnvironmentSubscribe).toHaveBeenCalledOnce())
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(unsubscribe).toHaveBeenCalledOnce()
    resolveSubscription({ unsubscribe })
    await Promise.resolve()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

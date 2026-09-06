// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKaneoApi, lookupKaneoTask } from './runtime-kaneo-client'
import type * as RuntimeRpcClient from './runtime-rpc-client'
import { callRuntimeRpc, RuntimeRpcCallError } from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return { ...actual, callRuntimeRpc: vi.fn() }
})
afterEach(() => vi.clearAllMocks())

describe('Kaneo runtime routing', () => {
  it('sends credentials to the selected runtime', async () => {
    const api = getKaneoApi({ activeRuntimeEnvironmentId: 'remote' })
    await api.connect({ siteUrl: 'https://tasks.example.com', apiKey: 'test-key' })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'remote' },
      'kaneo.connect',
      { siteUrl: 'https://tasks.example.com', apiKey: 'test-key' },
      { timeoutMs: 30_000 }
    )
  })

  it('reports an old runtime without falling back to local credentials', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'test',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'old' }
      })
    )
    await expect(getKaneoApi({ activeRuntimeEnvironmentId: 'old' }).status()).rejects.toThrow(
      'Update the selected Orca runtime'
    )
  })

  it('forwards cancellation to remote RPC', async () => {
    const signal = new AbortController().signal
    await lookupKaneoTask(
      { activeRuntimeEnvironmentId: 'remote' },
      'https://tasks.example.com/task',
      signal
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'remote' },
      'kaneo.getTask',
      { url: 'https://tasks.example.com/task' },
      { timeoutMs: 30_000, signal }
    )
  })

  it('cancels local IPC requests and rejects a late success', async () => {
    let resolve!: (value: never) => void
    const getTask = vi.fn(
      (_args: { url: string; requestId?: string }) =>
        new Promise<never>((done) => {
          resolve = done
        })
    )
    const cancelTask = vi.fn(async () => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { kaneo: { getTask, cancelTask } }
    })
    const controller = new AbortController()
    const result = lookupKaneoTask(null, 'task-url', controller.signal)
    controller.abort()
    resolve({ title: 'Late result' } as never)
    await expect(result).rejects.toThrow()
    expect(cancelTask).toHaveBeenCalledWith({ requestId: getTask.mock.calls[0][0].requestId })
  })
})

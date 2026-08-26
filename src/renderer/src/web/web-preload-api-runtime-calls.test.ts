import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web preload runtime calls', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('preserves success and failure envelopes while persisting response runtime metadata', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'runtime.failure') {
            return Promise.resolve({
              id: method,
              ok: false,
              error: { code: 'remote_failure', message: 'Remote failed', data: { retry: false } },
              _meta: { runtimeId: 'runtime-failure' }
            })
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: { value: 42 },
            _meta: { runtimeId: 'runtime-success' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.runtime.call({ method: 'runtime.success' })).resolves.toEqual({
      id: 'runtime.success',
      ok: true,
      result: { value: 42 },
      _meta: { runtimeId: 'runtime-success' }
    })
    expect(
      JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}')
    ).toMatchObject({ runtimeId: 'runtime-success' })

    await expect(globals.window.api.runtime.call({ method: 'runtime.failure' })).resolves.toEqual({
      id: 'runtime.failure',
      ok: false,
      error: { code: 'remote_failure', message: 'Remote failed', data: { retry: false } },
      _meta: { runtimeId: 'runtime-failure' }
    })
    expect(
      JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}')
    ).toMatchObject({ runtimeId: 'runtime-failure' })
  })

  it('unwraps domain failures to their message after persisting failure metadata', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: false,
            error: {
              code: 'repo_unavailable',
              message: 'Repository catalog is unavailable',
              data: { host: 'runtime-a' }
            },
            _meta: { runtimeId: 'runtime-domain-failure' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    let rejection: unknown
    try {
      await globals.window.api.repos.list()
    } catch (error) {
      rejection = error
    }

    expect(rejection).toEqual(new Error('Repository catalog is unavailable'))
    if (!(rejection instanceof Error)) {
      throw new Error('Expected a domain Error rejection')
    }
    expect(Reflect.get(rejection, 'code')).toBeUndefined()
    expect(
      JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}')
    ).toMatchObject({ runtimeId: 'runtime-domain-failure' })
  })

  it('surfaces per-environment queue overload without invoking the client', async () => {
    let release!: () => void
    const blocked = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      release = () =>
        resolve({
          id: 'runtime.blocked',
          ok: true,
          result: null,
          _meta: { runtimeId: 'runtime-a' }
        })
    })
    const call = vi.fn(() => blocked)
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const accepted = Array.from({ length: 264 }, (_, index) =>
      globals.window.api.runtime.call({ method: `runtime.blocked.${index}` })
    )
    const overloaded = globals.window.api.runtime.call({ method: 'runtime.overloaded' })

    await expect(overloaded).rejects.toMatchObject({
      code: 'runtime_rpc_queue_overloaded',
      scope: 'selector'
    })
    expect(call).toHaveBeenCalledTimes(8)
    release()
    await expect(Promise.all(accepted)).resolves.toHaveLength(264)
  })

  it('does not spend a selected call timeout while queued and forwards it unchanged', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const blocked = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      release = () =>
        resolve({
          id: 'runtime.blocker',
          ok: true,
          result: null,
          _meta: { runtimeId: 'runtime-a' }
        })
    })
    const call = vi.fn((method: string): Promise<RuntimeRpcResponse<unknown>> => {
      if (method.startsWith('runtime.blocker')) {
        return blocked
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: 'done',
        _meta: { runtimeId: 'runtime-a' }
      })
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const blockers = Array.from({ length: 8 }, (_, index) =>
      globals.window.api.runtime.call({ method: `runtime.blocker.${index}` })
    )
    const queued = globals.window.api.runtimeEnvironments.call({
      selector: 'web-server-a',
      method: 'runtime.queued-timeout',
      timeoutMs: 25
    })
    let settled = false
    void queued.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)
    expect(call).toHaveBeenCalledTimes(8)
    release()
    await Promise.all(blockers)
    await expect(queued).resolves.toMatchObject({ ok: true, result: 'done' })
    expect(call).toHaveBeenLastCalledWith('runtime.queued-timeout', undefined, { timeoutMs: 25 })
  })
})

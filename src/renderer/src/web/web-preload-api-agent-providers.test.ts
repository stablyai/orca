import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installApi,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web native chat preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('forwards validated lifecycle metadata from reads and stream frames', async () => {
    const lifecycle = { state: 'completed', turnId: 'turn-1', timestamp: 42 } as const
    const message = {
      id: 'a-1',
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'done' }],
      timestamp: 42,
      source: 'transcript' as const
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'read-1',
            ok: true,
            result: { messages: [message], lifecycle },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        subscribe(
          _method: string,
          _params: unknown,
          callbacks: { onResponse: (response: RuntimeRpcResponse<unknown>) => void }
        ): Promise<{ unsubscribe: () => void }> {
          callbacks.onResponse({
            id: 'stream-1',
            ok: true,
            result: {
              type: 'snapshot',
              messages: [message],
              hasMore: false,
              lifecycle
            },
            _meta: { runtimeId: 'runtime-1' }
          })
          return Promise.resolve({ unsubscribe: vi.fn() })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.nativeChat.readSession('claude', 'session-1')).resolves.toEqual(
      {
        messages: [message],
        lifecycle
      }
    )
    const frames: unknown[] = []
    globals.window.api.nativeChat.subscribe(
      { subscriptionId: 'sub-1', agent: 'claude', sessionId: 'session-1' },
      (frame) => frames.push(frame)
    )
    await Promise.resolve()

    expect(frames).toEqual([
      {
        type: 'snapshot',
        messages: [message],
        hasMore: false,
        lifecycle
      }
    ])
  })
})

describe('web MiniMax preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exposes desktop-only MiniMax credential reads as unconfigured and rejects saves', async () => {
    const { api } = await installApi('Linux')

    await expect(api.minimaxCredentials.getStatus()).resolves.toEqual({ configured: false })
    await expect(api.minimaxCredentials.saveCookie('_token=abc')).rejects.toThrow(/desktop app/i)
    await expect(api.minimaxCredentials.clearCookie()).resolves.toEqual({ configured: false })
  })
})

describe('web AI Vault preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('routes session scans through the paired runtime host', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const scanResult = {
      sessions: [],
      issues: [],
      scannedAt: '2026-07-04T00:00:00.000Z'
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: scanResult,
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.aiVault.listSessions({
        executionHostScope: 'all',
        limit: 25,
        force: true,
        scopePaths: ['/srv/app']
      })
    ).resolves.toEqual(scanResult)
    expect(runtimeCalls).toEqual([
      {
        method: 'aiVault.listSessions',
        params: {
          limit: 25,
          force: true,
          scopePaths: ['/srv/app'],
          executionHostId: 'runtime:web-env-1'
        }
      }
    ])
  })

  it('returns unavailable history for explicit non-runtime host scopes', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { sessions: [], issues: [], scannedAt: '2026-07-04T00:00:00.000Z' },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.aiVault.listSessions({ executionHostScope: 'local' })
    ).resolves.toEqual({
      sessions: [],
      issues: [
        expect.objectContaining({
          executionHostId: 'local',
          agent: 'codex'
        })
      ],
      scannedAt: expect.any(String)
    })
    expect(runtimeCalls).toEqual([])
  })
})

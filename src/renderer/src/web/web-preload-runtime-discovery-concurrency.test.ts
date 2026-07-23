import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installBrowserGlobals(): MemoryStorage {
  const storage = new MemoryStorage()
  vi.stubGlobal('window', {
    localStorage: storage,
    location: { protocol: 'http:', reload: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('navigator', { userAgent: 'Linux', hardwareConcurrency: 8 })
  return storage
}

function writeStoredRuntimeEnvironment(storage: Storage): void {
  storage.setItem(
    'orca.web.runtimeEnvironment.v1',
    JSON.stringify({
      id: 'web-env-1',
      name: 'Test runtime',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      preferredEndpointId: 'ws-web-env-1',
      endpoints: [
        {
          id: 'ws-web-env-1',
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'ws://127.0.0.1:1234',
          deviceToken: 'token',
          publicKeyB64: 'public-key'
        }
      ]
    })
  )
}

describe('web runtime repository discovery concurrency', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('resolves a 300-repository catalog without overflowing the shared RPC queue', async () => {
    const repoCount = 300
    let activeDetectedCalls = 0
    let peakDetectedCalls = 0
    let detectedCallCount = 0

    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'repo.list') {
            return Promise.resolve({
              id: 'repo-list',
              ok: true,
              result: {
                repos: Array.from({ length: repoCount }, (_, index) => ({
                  id: `repo-${index}`
                }))
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'worktree.detectedList') {
            const repoId = (params as { repo: string }).repo
            const index = Number(repoId.slice('repo-'.length))
            activeDetectedCalls += 1
            detectedCallCount += 1
            peakDetectedCalls = Math.max(peakDetectedCalls, activeDetectedCalls)
            return Promise.resolve({
              id: `detected-${index}`,
              ok: true as const,
              result: {
                repoId,
                authoritative: true,
                worktrees: [
                  {
                    id: `worktree-${index}`,
                    repoId,
                    path: `/workspace/repo-${index}`
                  }
                ]
              },
              _meta: { runtimeId: 'runtime-1' }
            }).finally(() => {
              activeDetectedCalls -= 1
            })
          }
          if (method === 'files.stat') {
            return Promise.resolve({
              id: 'file-stat',
              ok: true,
              result: { size: 1 },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          throw new Error(`Unexpected method: ${method}`)
        }

        close(): void {}
      }
    }))

    const storage = installBrowserGlobals()
    writeStoredRuntimeEnvironment(storage)
    const { installWebPreloadApi, WEB_RUNTIME_REPO_DISCOVERY_CONCURRENCY } =
      await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      window.api.fs.pathExists({ filePath: '/workspace/repo-299/file.txt' })
    ).resolves.toBe(true)
    expect(detectedCallCount).toBe(repoCount)
    expect(peakDetectedCalls).toBe(WEB_RUNTIME_REPO_DISCOVERY_CONCURRENCY)
  })
})

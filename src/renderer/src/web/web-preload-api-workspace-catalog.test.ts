import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  encodePairingCode,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web repos preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('does not reassign an in-flight catalog when the browser pairs to another server', async () => {
    let resolveCatalog!: (response: RuntimeRpcResponse<unknown>) => void
    const pendingCatalog = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      resolveCatalog = resolve
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return pendingCatalog
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const catalogPromise = globals.window.api.repos.list()
    const pairingCode = encodePairingCode({
      endpoint: 'wss://server-b.example:443',
      deviceToken: 'server-b-token',
      publicKeyB64: 'server-b-key'
    })
    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode
    })

    resolveCatalog({
      id: 'repo-list',
      ok: true,
      result: {
        repos: [
          {
            id: 'repo-a',
            path: '/srv/a',
            displayName: 'A',
            badgeColor: '#000',
            addedAt: 1,
            executionHostId: 'local'
          }
        ]
      },
      _meta: { runtimeId: 'runtime-a' }
    })

    await expect(catalogPromise).resolves.toMatchObject([
      { id: 'repo-a', executionHostId: 'runtime:web-server-a' }
    ])
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: paired.environment.id, name: 'Server B' }
    ])
  })
})

describe('web worktree preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('does not let a stale detected-worktree catalog repopulate the next server cache', async () => {
    let resolveServerA: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
    const detectedList = (repoId: string, path: string): RuntimeRpcResponse<unknown> => ({
      id: `detected-${repoId}`,
      ok: true,
      result: {
        repoId,
        authoritative: true,
        source: 'git',
        worktrees: [{ id: `${repoId}::${path}`, repoId, path }]
      },
      _meta: { runtimeId: `runtime-${repoId}` }
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        constructor(private readonly connection: { hostPublicKeyB64: string }) {}

        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          const serverA = this.connection.hostPublicKeyB64 === 'public-key'
          if (method === 'repo.list') {
            return Promise.resolve({
              id: 'repo-list',
              ok: true,
              result: { repos: [{ id: serverA ? 'repo-a' : 'repo-b' }] },
              _meta: { runtimeId: serverA ? 'runtime-a' : 'runtime-b' }
            })
          }
          if (serverA) {
            return new Promise((resolve) => {
              resolveServerA = resolve
            })
          }
          return Promise.resolve(detectedList('repo-b', '/srv/b'))
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const serverAStatus = globals.window.api.git.status({ worktreePath: '/srv/a' })
    await vi.waitFor(() => expect(resolveServerA).toBeTypeOf('function'))
    await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: encodePairingCode({ publicKeyB64: 'server-b-key' })
    })
    resolveServerA?.(detectedList('repo-a', '/srv/a'))

    await expect(serverAStatus).rejects.toThrow(
      'The paired Orca server changed while the request was in progress.'
    )
    await expect(globals.window.api.shell.pathExists('/srv/a/file.ts')).resolves.toBe(false)
    await expect(globals.window.api.shell.pathExists('/srv/b/file.ts')).resolves.toBe(true)
  })

  it('reuses the detected-worktree catalog cache until disconnect invalidates its runtime owner', async () => {
    const calls: string[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          calls.push(method)
          const results: Record<string, unknown> = {
            'status.get': { runtimeId: 'runtime-a', version: '1.0.0' },
            'repo.list': { repos: [{ id: 'repo-a' }] },
            'worktree.detectedList': {
              repoId: 'repo-a',
              authoritative: true,
              source: 'git',
              worktrees: [{ id: 'repo-a::/srv/a', repoId: 'repo-a', path: '/srv/a' }]
            }
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: results[method],
            _meta: { runtimeId: 'runtime-a' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.shell.pathExists('/srv/a/one.ts')).resolves.toBe(true)
    await expect(globals.window.api.shell.pathExists('/srv/a/two.ts')).resolves.toBe(true)
    await globals.window.api.runtimeEnvironments.disconnect({ selector: 'web-server-a' })
    await globals.window.api.runtimeEnvironments.connect({ selector: 'web-server-a' })
    await expect(globals.window.api.shell.pathExists('/srv/a/one.ts')).resolves.toBe(true)

    expect(calls).toEqual([
      'repo.list',
      'worktree.detectedList',
      'status.get',
      'repo.list',
      'worktree.detectedList'
    ])
  })

  it('does not run a legacy detected-worktree fallback against a newly paired server', async () => {
    const runtimeCalls: string[] = []
    let resolveDetected: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push(method)
          return new Promise((resolve) => {
            resolveDetected = resolve
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const detected = globals.window.api.worktrees.listDetected({ repoId: 'repo-1' })
    await vi.waitFor(() => expect(resolveDetected).toBeTypeOf('function'))
    await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: encodePairingCode({ publicKeyB64: 'server-b-key' })
    })
    resolveDetected?.({
      id: 'detected-list',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: worktree.detectedList' },
      _meta: { runtimeId: 'runtime-a' }
    })

    await expect(detected).rejects.toThrow(
      'The paired Orca server changed while the request was in progress.'
    )
    expect(runtimeCalls).toEqual(['worktree.detectedList'])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  TEST_COMMIT_OID,
  encodePairingCode,
  installApi,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web browser-local port capability', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns an explicit unavailable scan instead of an undefined fallback payload', async () => {
    const { api } = await installApi('Linux')

    await expect(api.workspacePorts.scan({})).resolves.toMatchObject({
      platform: 'linux',
      ports: [],
      unavailableReason: 'Workspace port scanning is unavailable for browser-local workspaces.'
    })
  })
})

describe('web repos preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('rejects desktop host-scoped reorders in paired web clients', async () => {
    const { api } = await installApi('Linux')

    await expect(
      api.repos.reorderForHost({ hostId: 'ssh:target', orderedIds: ['repo-1'] })
    ).rejects.toThrow('Host-scoped project reordering is unavailable in paired web clients.')
  })

  it('attributes a server-local catalog to the paired runtime that returned it', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'repo-list',
            ok: true,
            result: {
              repos: [
                {
                  id: 'repo-1',
                  path: '/srv/repo',
                  displayName: 'repo',
                  badgeColor: '#000',
                  addedAt: 1,
                  executionHostId: 'local'
                }
              ]
            },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.repos.list()).resolves.toMatchObject([
      { id: 'repo-1', executionHostId: 'runtime:web-server-a' }
    ])
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

  it.each([
    ['/home/alice', '/home/alice/orca/projects'],
    ['/', '/orca/projects'],
    ['C:\\', 'C:\\orca\\projects']
  ])(
    'resolves the default create-project parent from runtime host home %s',
    async (resolvedPath, expectedParent) => {
      const runtimeCalls: { method: string; params: unknown }[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
            runtimeCalls.push({ method, params })
            return Promise.resolve({
              id: method,
              ok: true,
              result: { resolvedPath, entries: [] },
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

      await expect(globals.window.api.repos.getDefaultCreateProjectParent()).resolves.toBe(
        expectedParent
      )
      expect(runtimeCalls).toEqual([{ method: 'files.browseServerDir', params: { path: '~' } }])
    }
  )
})

describe('web worktree preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('forwards force and archive-hook intent through worktree removal', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { removed: true },
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

    await globals.window.api.worktrees.remove({
      worktreeId: 'repo-1::/workspace/locked',
      force: true,
      skipArchive: false
    })
    await globals.window.api.worktrees.remove({
      worktreeId: 'repo-1::/workspace/dirty',
      force: true,
      skipArchive: true
    })

    expect(runtimeCalls).toEqual([
      {
        method: 'worktree.rm',
        params: {
          worktree: 'id:repo-1::/workspace/locked',
          force: true,
          runHooks: true
        }
      },
      {
        method: 'worktree.rm',
        params: {
          worktree: 'id:repo-1::/workspace/dirty',
          force: true,
          runHooks: false
        }
      }
    ])
  })

  it.each(['web-server-a', 'web-server-b'])(
    'attributes server-local worktrees to their own paired runtime %s',
    async (environmentId) => {
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(): Promise<RuntimeRpcResponse<unknown>> {
            return Promise.resolve({
              id: 'worktree-list',
              ok: true,
              result: {
                worktrees: [
                  {
                    id: 'repo-1::/srv/repo',
                    repoId: 'repo-1',
                    path: '/srv/repo',
                    hostId: 'local'
                  },
                  {
                    id: 'repo-2::/ssh/repo',
                    repoId: 'repo-2',
                    path: '/ssh/repo',
                    hostId: 'ssh:hub-private-target'
                  }
                ]
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }

          close(): void {}
        }
      }))

      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage, environmentId)
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()

      await expect(globals.window.api.worktrees.list({ repoId: 'repo-1' })).resolves.toMatchObject([
        {
          id: 'repo-1::/srv/repo',
          hostId: 'local',
          runtimeOwnerEnvironmentId: environmentId
        },
        {
          id: 'repo-2::/ssh/repo',
          hostId: 'ssh:hub-private-target',
          runtimeOwnerEnvironmentId: environmentId
        }
      ])
    }
  )

  it('does not let a stale listAll response repopulate the next server cache', async () => {
    let resolveServerA: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        constructor(private readonly offer: { publicKeyB64: string }) {}

        call(): Promise<RuntimeRpcResponse<unknown>> {
          if (this.offer.publicKeyB64 === 'public-key') {
            return new Promise((resolve) => {
              resolveServerA = resolve
            })
          }
          return Promise.resolve({
            id: 'server-b-list',
            ok: true,
            result: { worktrees: [{ id: 'worktree-b', repoId: 'repo-b', path: '/srv/b' }] },
            _meta: { runtimeId: 'runtime-b' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const serverAList = globals.window.api.worktrees.listAll()
    await vi.waitFor(() => expect(resolveServerA).toBeTypeOf('function'))
    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: encodePairingCode({ publicKeyB64: 'server-b-key' })
    })
    resolveServerA?.({
      id: 'server-a-list',
      ok: true,
      result: { worktrees: [{ id: 'worktree-a', repoId: 'repo-a', path: '/srv/a' }] },
      _meta: { runtimeId: 'runtime-a' }
    })

    await expect(serverAList).rejects.toThrow(
      'The paired Orca server changed while the request was in progress.'
    )
    await expect(globals.window.api.worktrees.listAll()).resolves.toMatchObject([
      { id: 'worktree-b', runtimeOwnerEnvironmentId: paired.environment.id }
    ])
  })

  it('reuses the worktree catalog cache until disconnect invalidates its runtime owner', async () => {
    const calls: string[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          calls.push(method)
          return Promise.resolve({
            id: method,
            ok: true,
            result:
              method === 'status.get'
                ? { runtimeId: 'runtime-a', version: '1.0.0' }
                : { worktrees: [{ id: 'worktree-a', repoId: 'repo-a', path: '/srv/a' }] },
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

    await globals.window.api.worktrees.listAll()
    await globals.window.api.worktrees.listAll()
    await globals.window.api.runtimeEnvironments.disconnect({ selector: 'web-server-a' })
    await globals.window.api.runtimeEnvironments.connect({ selector: 'web-server-a' })
    await globals.window.api.worktrees.listAll()

    expect(calls).toEqual(['worktree.list', 'status.get', 'worktree.list'])
  })

  it('preserves runtime-routed detected-worktree host ownership in the compatibility shape', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'detected-list',
            ok: true,
            result: {
              repoId: 'repo-1',
              authoritative: true,
              source: 'git',
              worktrees: [
                { id: 'repo-1::/srv/repo', repoId: 'repo-1', path: '/srv/repo', hostId: 'local' },
                {
                  id: 'repo-1::/ssh/repo',
                  repoId: 'repo-1',
                  path: '/ssh/repo',
                  hostId: 'ssh:hub-private-target'
                }
              ]
            },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-env-1')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.worktrees.listDetected({ repoId: 'repo-1' })
    ).resolves.toMatchObject({
      repoId: 'repo-1',
      authoritative: true,
      worktrees: [
        {
          hostId: 'local',
          runtimeOwnerEnvironmentId: 'web-env-1'
        },
        {
          hostId: 'ssh:hub-private-target',
          runtimeOwnerEnvironmentId: 'web-env-1'
        }
      ]
    })
  })

  it('falls back to legacy worktree.list when detectedList is unavailable', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const worktree = {
      id: 'repo-1::/workspace/repo',
      repoId: 'repo-1',
      path: '/workspace/repo',
      head: 'abc123',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true,
      displayName: 'repo',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      workspaceStatus: 'todo'
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'worktree.detectedList') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: false,
              error: {
                code: 'method_not_found',
                message: 'Unknown method: worktree.detectedList'
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { worktrees: [worktree], totalCount: 1, truncated: false },
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

    const result = await globals.window.api.worktrees.listDetected({ repoId: 'repo-1' })

    expect(result).toMatchObject({
      repoId: 'repo-1',
      authoritative: true,
      source: 'session-fallback',
      worktrees: [
        {
          id: worktree.id,
          runtimeOwnerEnvironmentId: 'web-env-1',
          ownership: 'orca-managed',
          visible: true
        }
      ]
    })
    expect(runtimeCalls).toEqual([
      { method: 'worktree.detectedList', params: { repo: 'repo-1' } },
      { method: 'worktree.list', params: { repo: 'repo-1', limit: 10_000 } }
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

  it('forwards review compare-base fields through runtime worktree calls', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'worktree.resolvePrBase') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { baseBranch: TEST_COMMIT_OID, compareBaseRef: 'refs/remotes/origin/main' },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'worktree.resolveMrBase') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: {
                baseBranch: 'origin/source',
                compareBaseRef: 'refs/remotes/origin/release'
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: {
              worktree: { id: 'repo-1::/workspace/review', path: '/workspace/review' }
            },
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

    await globals.window.api.worktrees.create({
      repoId: 'repo-1',
      name: 'review-pr-42',
      baseBranch: TEST_COMMIT_OID,
      compareBaseRef: 'refs/remotes/origin/main',
      setupDecision: 'inherit',
      createdWithAgent: 'codex',
      displayName: 'Review label',
      displayNameKind: 'user',
      startup: {
        command: "codex 'summarize repo'",
        env: { ORCA_AGENT_MODE: 'direct' },
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: '--model gpt-5',
          agentEnv: { ORCA_AGENT_MODE: 'direct' }
        },
        startupCommandDelivery: 'shell-ready'
      }
    })
    await globals.window.api.worktrees.resolvePrBase({
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'feature/fix',
      baseRefName: 'main',
      isCrossRepository: true
    })
    await globals.window.api.worktrees.resolveMrBase({
      repoId: 'repo-1',
      mrIid: 7,
      sourceBranch: 'feature/mr',
      targetBranch: 'release',
      isCrossRepository: false
    })
    await globals.window.api.worktrees.create({
      repoId: 'repo-1',
      name: 'nautilus',
      setupDecision: 'inherit',
      nameWasGenerated: true
    })

    expect(runtimeCalls).toEqual([
      {
        method: 'worktree.create',
        params: expect.objectContaining({
          repo: 'repo-1',
          baseBranch: TEST_COMMIT_OID,
          compareBaseRef: 'refs/remotes/origin/main',
          createdWithAgent: 'codex',
          displayName: 'Review label',
          displayNameKind: 'user',
          startupCommand: "codex 'summarize repo'",
          startupEnv: { ORCA_AGENT_MODE: 'direct' },
          startupLaunchConfig: {
            agentCommand: 'codex',
            agentArgs: '--model gpt-5',
            agentEnv: { ORCA_AGENT_MODE: 'direct' }
          },
          startupCommandDelivery: 'shell-ready',
          activate: true
        })
      },
      {
        method: 'worktree.resolvePrBase',
        params: {
          repo: 'repo-1',
          prNumber: 42,
          headRefName: 'feature/fix',
          baseRefName: 'main',
          isCrossRepository: true
        }
      },
      {
        method: 'worktree.resolveMrBase',
        params: {
          repo: 'repo-1',
          mrIid: 7,
          sourceBranch: 'feature/mr',
          targetBranch: 'release',
          isCrossRepository: false
        }
      },
      {
        method: 'worktree.create',
        params: expect.objectContaining({ repo: 'repo-1', nameWasGenerated: true })
      }
    ])
    // Why: this client hand-enumerates create params, so a new optional field silently vanishes.
    // Absent must mean user-typed — the host neither skips a retired candidate nor retires it.
    expect(runtimeCalls[0]?.params).not.toHaveProperty('nameWasGenerated')
  })

  // Why: without it the host records the app's parent pick as a CLI flag, which cleans up differently.
  it('marks a parent-picked create as a manual action', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { worktree: { id: 'repo-1::/workspace/child', path: '/workspace/child' } },
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

    await globals.window.api.worktrees.create({
      repoId: 'repo-1',
      name: 'child',
      setupDecision: 'inherit'
    })
    await globals.window.api.worktrees.create({
      repoId: 'repo-1',
      name: 'child',
      setupDecision: 'inherit',
      parentWorkspace: 'folder:folder-1'
    })

    expect(runtimeCalls[0]?.params).not.toHaveProperty('parentWorkspaceOrigin')
    expect(runtimeCalls[1]?.params).toMatchObject({
      parentWorkspace: 'folder:folder-1',
      parentWorkspaceOrigin: 'manual'
    })
  })

  it('encodes explicit push target clears for runtime worktree updates', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: {
              worktree: { id: 'repo-1::/workspace/review', path: '/workspace/review' }
            },
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

    await globals.window.api.worktrees.updateMeta({
      worktreeId: 'repo-1::/workspace/review',
      updates: { linkedPR: null, pushTarget: undefined }
    })

    expect(runtimeCalls).toEqual([
      {
        method: 'worktree.set',
        params: {
          worktree: 'id:repo-1::/workspace/review',
          linkedPR: null,
          pushTarget: null
        }
      }
    ])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workItemsCacheKey } from '../github/cache-identity'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import type { AppState } from '../types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'

describe('createGitHubSlice.fetchWorkItems source/error envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('routes work item fetches through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items',
      ok: true,
      result: {
        items: [{ type: 'issue', number: 7, title: 'Server issue', url: 'https://example.test/7' }],
        sources: {
          issues: { owner: 'up', repo: 'r' },
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repos: AppState['repos'] = [
      {
        id: 'runtime-repo-id',
        path: '/server/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      }
    ]
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos
    } as Partial<AppState>)

    await store.getState().fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open', {
      force: true,
      noCache: true
    })

    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.listWorkItems',
      params: {
        repo: 'runtime-repo-id',
        limit: 24,
        query: 'is:open',
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', 'runtime:env-1')
      ].data?.[0]
    ).toMatchObject({
      repoId: 'caller-repo-id',
      number: 7
    })
  })

  it('routes work item fetches through the owning runtime when local is focused', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-owner',
      ok: true,
      result: {
        items: [
          { type: 'issue', number: 17, title: 'Owner issue', url: 'https://example.test/17' }
        ],
        sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: null,
      repos: [
        {
          id: 'runtime-repo-id',
          path: '/server/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          executionHostId: 'runtime:env-1'
        }
      ]
    } as Partial<AppState>)

    await store.getState().fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open')

    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.listWorkItems',
      params: {
        repo: 'runtime-repo-id',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', 'runtime:env-1')
      ]?.data?.[0]
    ).toMatchObject({ repoId: 'caller-repo-id', number: 17 })
  })

  it('routes work item fetches through an explicit GitHub source context', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-source-context',
      ok: true,
      result: {
        items: [
          { type: 'issue', number: 19, title: 'Source issue', url: 'https://example.test/19' }
        ],
        sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
      },
      _meta: { runtimeId: 'source-runtime' }
    })
    const store = createTestStore()
    const repos: AppState['repos'] = [
      {
        id: 'local-repo-id',
        path: '/server/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      }
    ]
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos
    } as Partial<AppState>)

    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:source-runtime' as const,
      projectHostSetupId: 'setup-1',
      repoId: 'source-runtime-repo-id',
      providerIdentity: { provider: 'github' as const, owner: 'stablyai', repo: 'orca' }
    }

    await store.getState().fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open', {
      sourceContext
    })

    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'source-runtime',
      method: 'github.listWorkItems',
      params: {
        repo: 'source-runtime-repo-id',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', getTaskSourceCacheScope(sourceContext))
      ]?.data?.[0]
    ).toMatchObject({ repoId: 'caller-repo-id', number: 19 })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', 'runtime:focused-runtime')
      ]
    ).toBeUndefined()
  })

  it('keeps explicit GitHub source identities in separate work-item cache buckets', async () => {
    const store = createTestStore()
    const firstSourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'project-1',
      hostId: 'local' as const,
      projectHostSetupId: 'setup-1',
      repoId: 'repo-1',
      providerIdentity: { provider: 'github' as const, owner: 'acme', repo: 'orca' }
    }
    const secondSourceContext = {
      ...firstSourceContext,
      providerIdentity: { provider: 'github' as const, owner: 'stablyai', repo: 'orca' }
    }
    mockApi.gh.listWorkItems
      .mockResolvedValueOnce({
        items: [{ type: 'issue', number: 1, title: 'Acme', url: 'https://example.test/1' }],
        sources: { issues: { owner: 'acme', repo: 'orca' }, prs: { owner: 'acme', repo: 'orca' } }
      })
      .mockResolvedValueOnce({
        items: [{ type: 'issue', number: 2, title: 'Stably', url: 'https://example.test/2' }],
        sources: {
          issues: { owner: 'stablyai', repo: 'orca' },
          prs: { owner: 'stablyai', repo: 'orca' }
        }
      })

    await store.getState().fetchWorkItems('repo-1', '/repo', 24, '', {
      sourceContext: firstSourceContext
    })
    await store.getState().fetchWorkItems('repo-1', '/repo', 24, '', {
      sourceContext: secondSourceContext
    })

    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('repo-1', 24, '', getTaskSourceCacheScope(firstSourceContext))
      ]?.data?.[0]?.number
    ).toBe(1)
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('repo-1', 24, '', getTaskSourceCacheScope(secondSourceContext))
      ]?.data?.[0]?.number
    ).toBe(2)
  })

  it('routes SSH-owned work item fetches through local IPC when a runtime is focused', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [{ type: 'issue', number: 27, title: 'SSH issue', url: 'https://example.test/27' }],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as AppState['settings'],
      repos: [
        {
          id: 'ssh-repo-id',
          path: '/ssh/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      ]
    } as Partial<AppState>)

    await store.getState().fetchWorkItems('ssh-repo-id', '/ssh/repo', 24, '')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/ssh/repo',
      repoId: 'ssh-repo-id',
      limit: 24,
      query: undefined
    })
    expect(
      store.getState().workItemsCache[workItemsCacheKey('ssh-repo-id', 24, '', 'ssh:ssh-1')]
        ?.data?.[0]
    ).toMatchObject({ repoId: 'ssh-repo-id', number: 27 })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('ssh-repo-id', 24, '', 'runtime:env-focused')
      ]
    ).toBeUndefined()
  })

  it('falls back to local work-item IPC when no runtime environment is active', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [{ type: 'issue', number: 7, title: 'Local issue', url: 'https://example.test/7' }],
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'up', repo: 'r' },
        originCandidate: { owner: 'up', repo: 'r' },
        upstreamCandidate: null
      }
    })

    await store.getState().fetchWorkItems('repo-id', '/local/repo', 24, '')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/local/repo',
      repoId: 'repo-id',
      limit: 24,
      query: undefined
    })
  })

  it('falls back to local work-item IPC when the active runtime has no matching repo path', async () => {
    const store = createTestStore()
    const error = new Error('Access denied: unknown repository path')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/known-repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    mockApi.gh.listWorkItems.mockRejectedValueOnce(error)

    try {
      await expect(
        store.getState().fetchWorkItems('repo-id', '/server/missing-repo', 24, '')
      ).rejects.toThrow(error)
    } finally {
      consoleError.mockRestore()
    }

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/server/missing-repo',
      repoId: 'repo-id',
      limit: 24,
      query: undefined
    })
  })

  it('uses the request-start runtime repo snapshot and skips cache writes after a runtime switch', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: GitHubWorkItem[]
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    const blockingResolvers: ((value: WorkItemsEnvelope) => void)[] = []
    for (let i = 0; i < 8; i++) {
      mockApi.gh.listWorkItems.mockImplementationOnce(
        () =>
          new Promise<WorkItemsEnvelope>((resolve) => {
            blockingResolvers.push(resolve)
          })
      )
    }

    const blockers = Array.from({ length: 8 }, (_, i) =>
      store.getState().fetchWorkItems(`blocker-${i}`, `/local/blocker-${i}`, 24, '')
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(blockingResolvers).toHaveLength(8)

    const item = {
      type: 'issue',
      number: 42,
      title: 'Started before switch',
      url: 'https://example.test/42',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-started-before-switch',
      ok: true,
      result: {
        items: [item],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-start' },
      repos: [{ id: 'repo-start', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    const queued = store
      .getState()
      .fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open', { force: true })

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-switched' },
      repos: [{ id: 'repo-switched', path: '/server/repo', name: 'repo', kind: 'git' }],
      workItemsCache: {}
    } as unknown as Partial<AppState>)
    for (const resolve of blockingResolvers) {
      resolve({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })
    }

    const result = await queued
    await Promise.all(blockers)

    expect(result).toEqual([{ ...item, repoId: 'caller-repo-id' }])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-start',
      method: 'github.listWorkItems',
      params: {
        repo: 'repo-start',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().workItemsCache[workItemsCacheKey('caller-repo-id', 24, 'is:open')]
    ).toBeUndefined()
  })

  it('does not reuse an old-runtime in-flight work-item fetch after a runtime switch', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: GitHubWorkItem[]
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    type WorkItemsRpcResponse = {
      id: string
      ok: true
      result: WorkItemsEnvelope
      _meta: { runtimeId: string }
    }
    let resolveOldRuntime: (value: WorkItemsRpcResponse) => void = () => {}
    let resolveNewRuntime: (value: WorkItemsRpcResponse) => void = () => {}
    runtimeEnvironmentCall
      .mockImplementationOnce(
        () =>
          new Promise<WorkItemsRpcResponse>((resolve) => {
            resolveOldRuntime = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<WorkItemsRpcResponse>((resolve) => {
            resolveNewRuntime = resolve
          })
      )

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-old' },
      repos: [{ id: 'repo-old-runtime', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    const oldFetch = store
      .getState()
      .fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-new' },
      repos: [{ id: 'repo-new-runtime', path: '/server/repo', name: 'repo', kind: 'git' }],
      workItemsCache: {}
    } as unknown as Partial<AppState>)
    const newFetch = store
      .getState()
      .fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2))

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-old',
      method: 'github.listWorkItems',
      params: {
        repo: 'repo-old-runtime',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-new',
      method: 'github.listWorkItems',
      params: {
        repo: 'repo-new-runtime',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })

    const newRuntimeItem = {
      type: 'issue',
      number: 2,
      title: 'New runtime item',
      url: 'https://example.test/new',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    resolveNewRuntime({
      id: 'rpc-new-work-items',
      ok: true,
      result: {
        items: [newRuntimeItem],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'new-runtime' }
    })
    await expect(newFetch).resolves.toEqual([{ ...newRuntimeItem, repoId: 'caller-repo-id' }])

    const oldRuntimeItem = {
      type: 'issue',
      number: 1,
      title: 'Old runtime item',
      url: 'https://example.test/old',
      updatedAt: '2026-05-21T00:00:00Z'
    } as GitHubWorkItem
    resolveOldRuntime({
      id: 'rpc-old-work-items',
      ok: true,
      result: {
        items: [oldRuntimeItem],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'old-runtime' }
    })
    await expect(oldFetch).resolves.toEqual([{ ...oldRuntimeItem, repoId: 'caller-repo-id' }])
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', 'runtime:env-new')
      ]?.data
    ).toEqual([{ ...newRuntimeItem, repoId: 'caller-repo-id' }])
  })

  it('bounds work-item cache entries across many repos', async () => {
    vi.useFakeTimers()

    try {
      const store = createTestStore()
      mockApi.gh.listWorkItems.mockResolvedValue({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })

      for (let i = 0; i <= 500; i++) {
        vi.setSystemTime(1_000 + i)
        await store.getState().fetchWorkItems(`repo-${i}`, `/repo/${i}`, 24, '')
      }

      const cache = store.getState().workItemsCache
      expect(Object.keys(cache)).toHaveLength(500)
      expect(cache[workItemsCacheKey('repo-0', 24, '')]).toBeUndefined()
      expect(cache[workItemsCacheKey('repo-500', 24, '')]).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

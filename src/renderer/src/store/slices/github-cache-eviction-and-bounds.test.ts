import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueCacheKey, workItemsCacheKey } from './github'
import {
  createTestStore,
  githubSourceContext,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import type { AppState } from '../types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'

describe('createGitHubSlice.evictGitHubRepoCaches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('evicts repo-id and legacy path scoped cache entries', () => {
    const store = createTestStore()
    const repoId = 'repo-1'
    const repoPath = '/repo/one'
    store.setState({
      workItemsInvalidationNonce: 4,
      workItemsCache: {
        [workItemsCacheKey(repoId, 20, '')]: { data: [], fetchedAt: 1 },
        [workItemsCacheKey(repoPath, 20, '')]: { data: [], fetchedAt: 1 },
        [workItemsCacheKey('repo-2', 20, '')]: { data: [], fetchedAt: 1 }
      },
      prCache: {
        [`${repoId}::branch`]: { data: makePR(), fetchedAt: 1 },
        [`${repoPath}::branch`]: { data: makePR(), fetchedAt: 1 },
        'repo-2::branch': { data: makePR(), fetchedAt: 1 }
      },
      issueCache: {
        [`${repoId}::12`]: { data: {} as never, fetchedAt: 1 },
        [`${repoPath}::12`]: { data: {} as never, fetchedAt: 1 },
        'repo-2::12': { data: {} as never, fetchedAt: 1 }
      },
      checksCache: {
        [`${repoId}::pr-checks::12`]: { data: [], fetchedAt: 1 },
        [`${repoPath}::pr-checks::12`]: { data: [], fetchedAt: 1 },
        'repo-2::pr-checks::12': { data: [], fetchedAt: 1 }
      },
      commentsCache: {
        [`${repoId}::pr-comments::12`]: { data: [], fetchedAt: 1 },
        [`${repoPath}::pr-comments::12`]: { data: [], fetchedAt: 1 },
        'repo-2::pr-comments::12': { data: [], fetchedAt: 1 }
      }
    })

    store.getState().evictGitHubRepoCaches(repoId, repoPath)
    const state = store.getState()

    expect(Object.keys(state.workItemsCache)).toEqual([workItemsCacheKey('repo-2', 20, '')])
    expect(Object.keys(state.prCache)).toEqual(['repo-2::branch'])
    expect(Object.keys(state.issueCache)).toEqual(['repo-2::12'])
    expect(Object.keys(state.checksCache)).toEqual(['repo-2::pr-checks::12'])
    expect(Object.keys(state.commentsCache)).toEqual(['repo-2::pr-comments::12'])
    expect(state.workItemsInvalidationNonce).toBe(5)
  })

  it('does not bump the work-item invalidation nonce when no work-item entries are evicted', () => {
    const store = createTestStore()
    store.setState({
      workItemsInvalidationNonce: 4,
      prCache: {
        'repo-1::branch': { data: makePR(), fetchedAt: 1 }
      }
    })

    store.getState().evictGitHubRepoCaches('repo-1', '/repo/one')

    expect(store.getState().prCache).toEqual({})
    expect(store.getState().workItemsInvalidationNonce).toBe(4)
  })

  it('clears matching in-flight work-item dedupe keys before the next fetch', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: []
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    let resolveFirst: (value: WorkItemsEnvelope) => void = () => {}
    const firstRequest = new Promise<WorkItemsEnvelope>((resolve) => {
      resolveFirst = resolve
    })
    mockApi.gh.listWorkItems.mockReturnValueOnce(firstRequest).mockResolvedValueOnce({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })

    const firstFetch = store.getState().fetchWorkItems('repo-1', '/repo/one', 20, '')
    await Promise.resolve()
    store.getState().evictGitHubRepoCaches('repo-1', '/repo/one')
    const secondFetch = store.getState().fetchWorkItems('repo-1', '/repo/one', 20, '')
    resolveFirst({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })
    await firstFetch
    await secondFetch

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
  })

  it('does not let a stale pre-invalidation work-item response rewrite the cache', async () => {
    const store = createTestStore()
    const item = {
      type: 'pr',
      number: 42,
      title: 'Old origin PR',
      url: 'https://example.test/42',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    let resolveFirst: (value: {
      items: GitHubWorkItem[]
      sources: {
        issues: null
        prs: { owner: 'fork'; repo: 'r' }
        originCandidate: { owner: 'fork'; repo: 'r' }
        upstreamCandidate: { owner: 'up'; repo: 'r' }
      }
    }) => void = () => {}
    mockApi.gh.listWorkItems.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )

    const firstFetch = store.getState().fetchWorkItems('repo-1', '/repo/one', 20, '')
    await Promise.resolve()
    store.setState((s) => ({ workItemsInvalidationNonce: s.workItemsInvalidationNonce + 1 }))
    resolveFirst({
      items: [item],
      sources: {
        issues: null,
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      }
    })

    await expect(firstFetch).resolves.toEqual([{ ...item, repoId: 'repo-1' }])
    expect(store.getState().workItemsCache[workItemsCacheKey('repo-1', 20, '')]).toBeUndefined()
  })
})

describe('createGitHubSlice cache bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.issue.mockReset()
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds restored PR and issue caches', async () => {
    const store = createTestStore()
    const pr = Object.fromEntries(
      Array.from({ length: 505 }, (_, index) => [
        `repo-id::branch-${index}`,
        { data: makePR({ number: index }), fetchedAt: index }
      ])
    )
    const issue = Object.fromEntries(
      Array.from({ length: 505 }, (_, index) => [
        `repo-id::${index}`,
        { data: { number: index } as never, fetchedAt: index }
      ])
    )
    mockApi.cache.getGitHub.mockResolvedValueOnce({ pr, issue })

    await store.getState().initGitHubCache()

    expect(Object.keys(store.getState().prCache)).toHaveLength(500)
    expect(Object.keys(store.getState().issueCache)).toHaveLength(500)
    expect(store.getState().prCache['repo-id::branch-0']).toBeUndefined()
    expect(store.getState().issueCache['repo-id::0']).toBeUndefined()
  })

  it('bounds PR and issue caches as fetches add entries', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    mockApi.gh.refreshPRNow.mockImplementation(({ candidate }) => ({
      kind: 'found',
      pr: makePR({ title: candidate.branch }),
      fetchedAt: Date.now()
    }))
    mockApi.gh.issue.mockImplementation(({ number }) => ({
      number,
      title: `Issue ${number}`,
      state: 'open',
      url: `https://example.com/issues/${number}`
    }))

    for (let index = 0; index < 505; index++) {
      vi.setSystemTime(index)
      await store.getState().fetchPRForBranch(repoPath, `branch-${index}`, {
        force: true,
        repoId
      })
      await store.getState().fetchIssue(repoPath, index, { repoId })
    }

    expect(Object.keys(store.getState().prCache)).toHaveLength(500)
    expect(Object.keys(store.getState().issueCache)).toHaveLength(500)
    expect(store.getState().prCache['repo-id::branch-0']).toBeUndefined()
    expect(store.getState().issueCache['repo-id::0']).toBeUndefined()

    await vi.runOnlyPendingTimersAsync()
  })

  it('routes runtime-owned issue fetches through the owning runtime when local is focused', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-issue-owner',
      ok: true,
      result: {
        number: 123,
        title: 'Runtime issue',
        state: 'open',
        url: 'https://example.com/issues/123'
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/runtime/repo'
    store.setState({
      settings: null,
      repos: [
        {
          id: 'repo-runtime',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchIssue(repoPath, 123, { repoId: 'repo-runtime' })
    ).resolves.toMatchObject({ number: 123, title: 'Runtime issue' })

    expect(mockApi.gh.issue).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.issue',
      params: { repo: 'repo-runtime', number: 123 },
      timeoutMs: 30_000
    })
    expect(
      store.getState().issueCache[
        issueCacheKey(repoPath, 'repo-runtime', 123, null, null, 'runtime:env-1')
      ]?.data
    ).toMatchObject({ number: 123 })
  })

  it('routes explicit source-context issue fetches through the source runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-source-issue',
      ok: true,
      result: {
        number: 19,
        title: 'Source issue',
        state: 'open',
        url: 'https://example.com/issues/19'
      },
      _meta: { runtimeId: 'source-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'caller-repo-id'
    const sourceContext = githubSourceContext('runtime:source-runtime', 'runtime-repo-id')
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as AppState['settings'],
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchIssue(repoPath, 19, { repoId, sourceContext })
    ).resolves.toMatchObject({ number: 19, title: 'Source issue' })

    expect(mockApi.gh.issue).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'source-runtime',
      method: 'github.issue',
      params: { repo: 'runtime-repo-id', number: 19 },
      timeoutMs: 30_000
    })
    expect(
      store.getState().issueCache[`${getTaskSourceCacheScope(sourceContext)}::${repoId}::19`]?.data
    ).toMatchObject({ number: 19 })
  })

  it('routes SSH-owned issue fetches through local IPC when a runtime is focused', async () => {
    mockApi.gh.issue.mockResolvedValueOnce({
      number: 321,
      title: 'SSH issue',
      state: 'open',
      url: 'https://example.com/issues/321'
    })
    const store = createTestStore()
    const repoPath = '/ssh/repo'
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as AppState['settings'],
      repos: [
        {
          id: 'repo-ssh',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchIssue(repoPath, 321, { repoId: 'repo-ssh' })
    ).resolves.toMatchObject({
      number: 321,
      title: 'SSH issue'
    })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.issue).toHaveBeenCalledWith({ repoPath, repoId: 'repo-ssh', number: 321 })
    expect(
      store.getState().issueCache[
        issueCacheKey(repoPath, 'repo-ssh', 321, null, 'ssh-1', 'ssh:ssh-1')
      ]?.data
    ).toMatchObject({ number: 321 })
    expect(
      store.getState().issueCache[
        issueCacheKey(repoPath, 'repo-ssh', 321, {
          activeRuntimeEnvironmentId: 'env-focused'
        } as AppState['settings'])
      ]
    ).toBeUndefined()
  })
})

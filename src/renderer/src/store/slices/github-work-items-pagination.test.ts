import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import type { AppState } from '../types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/work-items'
import { GITHUB_WORK_ITEMS_QUERY_MAX_BYTES } from './github-work-items-query-bounds'

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

  it('quietly skips SSH repos without a resolved GitHub remote in next-page fetches', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const item = {
      type: 'issue',
      number: 8,
      title: 'Server issue',
      url: 'https://example.test/8',
      updatedAt: '2026-05-21T00:00:00Z'
    } as GitHubWorkItem

    mockApi.gh.listWorkItems
      .mockRejectedValueOnce(new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE))
      .mockResolvedValueOnce({
        items: [item],
        sources: {
          issues: { owner: 'up', repo: 'r' },
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
      })

    try {
      const result = await store.getState().fetchWorkItemsNextPage(
        [
          { repoId: 'ssh-repo', path: '/server/ssh-repo' },
          { repoId: 'github-repo', path: '/server/github-repo' }
        ],
        24,
        100,
        '',
        1
      )

      expect(result.failedCount).toBe(0)
      expect(result.items).toEqual([{ ...item, repoId: 'github-repo' }])
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('reports skipped SSH repos when a complete first page is required', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockRejectedValueOnce(
      new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
    )

    const result = await store
      .getState()
      .fetchWorkItemsAcrossRepos([{ repoId: 'ssh-repo', path: '/server/ssh-repo' }], 24, 100, '', {
        requireComplete: true
      })

    expect(result.failedCount).toBe(1)
    expect(result.requestFailureCount).toBe(1)
  })

  it('reports skipped SSH repos when a complete later page is required', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockRejectedValueOnce(
      new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
    )

    const result = await store
      .getState()
      .fetchWorkItemsNextPage([{ repoId: 'ssh-repo', path: '/server/ssh-repo' }], 24, 100, '', 1, {
        requireComplete: true
      })

    expect(result.failedCount).toBe(1)
  })

  it('rejects provider-side partial data from a complete later-page result', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [
        {
          id: 'issue:1',
          type: 'issue',
          number: 1,
          title: 'Partial',
          state: 'open',
          url: 'https://github.com/o/r/issues/1',
          labels: [],
          updatedAt: '2026-05-22T00:00:00Z',
          author: 'author'
        }
      ],
      sources: {
        issues: { owner: 'o', repo: 'r' },
        prs: { owner: 'o', repo: 'r' },
        originCandidate: { owner: 'o', repo: 'r' },
        upstreamCandidate: null
      },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })

    const result = await store
      .getState()
      .fetchWorkItemsNextPage([{ repoId: 'repo-1', path: '/repo' }], 24, 100, '', 2, {
        requireComplete: true
      })

    expect(result.items).toEqual([])
    expect(result.failedCount).toBe(1)
    expect(result.errorTypes).toEqual(['permission_denied'])
  })

  it('routes work-item next-page fetches through the active runtime environment', async () => {
    const item = {
      type: 'pr',
      number: 9,
      title: 'Server PR',
      url: 'https://example.test/9',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-page',
      ok: true,
      result: {
        items: [item],
        sources: {
          issues: null,
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .fetchWorkItemsNextPage(
        [{ repoId: 'caller-repo-id', path: '/server/repo' }],
        24,
        100,
        'is:open',
        1,
        { noCache: true }
      )

    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.listWorkItems',
      params: {
        repo: 'runtime-repo-id',
        limit: 24,
        query: 'is:open',
        page: 1,
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(result).toEqual({
      items: [{ ...item, repoId: 'caller-repo-id' }],
      failedCount: 0,
      errorTypes: []
    })
  })

  it('surfaces issue-side envelope errors as errorTypes on next-page fetches', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-page-422',
      ok: true,
      result: {
        items: [],
        sources: {
          issues: { owner: 'up', repo: 'r' },
          prs: null,
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        },
        errors: {
          issues: { type: 'validation_error', message: 'only the first 1000 search results' }
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .fetchWorkItemsNextPage([{ repoId: 'caller-repo-id', path: '/server/repo' }], 24, 100, '', 34)

    // The window 422 travels on the envelope error channel, not failedCount —
    // resolveEmptyPageOutcome keys on this exact string (#11485).
    expect(result).toEqual({ items: [], failedCount: 0, errorTypes: ['validation_error'] })
  })

  it('demotes non-window validation errors so they cannot drive the unreachable clamp', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-page-422-other',
      ok: true,
      result: {
        items: [],
        sources: {
          issues: { owner: 'up', repo: 'r' },
          prs: null,
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        },
        errors: {
          issues: { type: 'validation_error', message: 'Validation Failed: query is malformed' }
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .fetchWorkItemsNextPage([{ repoId: 'caller-repo-id', path: '/server/repo' }], 24, 100, '', 2)

    expect(result).toEqual({ items: [], failedCount: 0, errorTypes: ['unknown'] })
  })

  it('surfaces PR-side envelope errors demoted so they read as failures, never window 422s', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-page-prs-error',
      ok: true,
      result: {
        items: [],
        sources: {
          issues: null,
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        },
        errors: {
          prs: { type: 'validation_error', message: 'Failed to load pull requests: bad flag' }
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .fetchWorkItemsNextPage([{ repoId: 'caller-repo-id', path: '/server/repo' }], 24, 100, '', 2)

    // A swallowed PR-side failure must not read as end-of-data (#11485), and a
    // PR-side validation error must never join the issue-only window signal.
    expect(result).toEqual({ items: [], failedCount: 0, errorTypes: ['unknown'] })
  })

  it('routes work-item counts through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-count',
      ok: true,
      result: 12,
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .countWorkItemsAcrossRepos(
        [{ repoId: 'caller-repo-id', path: '/server/repo' }],
        'is:open',
        10
      )

    expect(result).toEqual({ totalCount: 12, totalPages: 2 })
    expect(mockApi.gh.countWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.countWorkItems',
      params: {
        repo: 'runtime-repo-id',
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
  })

  it('falls back to local IPC for work-item counts without an active runtime environment', async () => {
    const store = createTestStore()
    mockApi.gh.countWorkItems.mockResolvedValueOnce(7)

    const result = await store
      .getState()
      .countWorkItemsAcrossRepos([{ repoId: 'repo-id', path: '/local/repo' }], '', 10)

    expect(result).toEqual({ totalCount: 7, totalPages: 1 })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.countWorkItems).toHaveBeenCalledWith({
      repoPath: '/local/repo',
      repoId: 'repo-id',
      query: undefined
    })
  })

  it('derives page count from the repo with the most results', async () => {
    const store = createTestStore()
    mockApi.gh.countWorkItems.mockResolvedValueOnce(100).mockResolvedValueOnce(1)

    const result = await store.getState().countWorkItemsAcrossRepos(
      [
        { repoId: 'large-repo', path: '/local/large' },
        { repoId: 'small-repo', path: '/local/small' }
      ],
      'is:issue',
      36
    )

    expect(result).toEqual({ totalCount: 101, totalPages: 3 })
  })

  it('caps advertised pages at the GitHub search result window', async () => {
    const store = createTestStore()
    mockApi.gh.countWorkItems.mockResolvedValueOnce(1170).mockResolvedValueOnce(1)

    const result = await store.getState().countWorkItemsAcrossRepos(
      [
        { repoId: 'large-repo', path: '/local/large' },
        { repoId: 'small-repo', path: '/local/small' }
      ],
      'is:issue',
      30
    )

    // 1170 results → 39 naive pages, but the Search API 422s once a page
    // starts past its 1000-result window; ceil(1000 / 30) = 34 stay reachable.
    expect(result).toEqual({ totalCount: 1171, totalPages: 34 })
  })

  it('pins the search-window cap at dividing and non-dividing per-repo limits', async () => {
    const store = createTestStore()
    // 36 is the shipped single-repo limit: page 28 starts at result 973 and is
    // served; page 29 starts past 1000 and 422s.
    mockApi.gh.countWorkItems.mockResolvedValueOnce(2000)
    await expect(
      store
        .getState()
        .countWorkItemsAcrossRepos([{ repoId: 'repo-id', path: '/local/repo' }], 'is:issue', 36)
    ).resolves.toEqual({ totalCount: 2000, totalPages: 28 })
    // 25 divides 1000 evenly: the full window stays reachable (40 pages).
    mockApi.gh.countWorkItems.mockResolvedValueOnce(2000)
    await expect(
      store
        .getState()
        .countWorkItemsAcrossRepos([{ repoId: 'repo-id', path: '/local/repo' }], 'is:issue', 25)
    ).resolves.toEqual({ totalCount: 2000, totalPages: 40 })
  })

  it('rejects oversized work-item queries before cache keys or provider calls', async () => {
    const store = createTestStore()
    const secret = 'github-work-items-secret'
    const oversizedQuery = secret + 'x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES)

    await expect(
      store.getState().fetchWorkItems('repo-id', '/local/repo', 24, oversizedQuery)
    ).resolves.toEqual([])
    await expect(
      store
        .getState()
        .fetchWorkItemsAcrossRepos(
          [{ repoId: 'repo-id', path: '/local/repo' }],
          24,
          24,
          oversizedQuery
        )
    ).resolves.toEqual({ items: [], failedCount: 0, githubUnavailable: false })
    await expect(
      store
        .getState()
        .fetchWorkItemsNextPage(
          [{ repoId: 'repo-id', path: '/local/repo' }],
          24,
          24,
          oversizedQuery,
          1
        )
    ).resolves.toEqual({ items: [], failedCount: 0, errorTypes: [] })
    await expect(
      store
        .getState()
        .countWorkItemsAcrossRepos([{ repoId: 'repo-id', path: '/local/repo' }], oversizedQuery, 24)
    ).resolves.toEqual({ totalCount: 0, totalPages: 0 })
    store.getState().prefetchWorkItems('repo-id', '/local/repo', 24, oversizedQuery)

    expect(store.getState().getCachedWorkItems('repo-id', 24, oversizedQuery, '/local/repo')).toBe(
      null
    )
    expect(
      store.getState().getWorkItemsSourcesAndError('repo-id', 24, oversizedQuery, '/local/repo')
    ).toEqual({ sources: null, error: null })
    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(mockApi.gh.countWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(JSON.stringify(store.getState().workItemsCache)).not.toContain(secret)
  })
})

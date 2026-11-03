import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import './store-test-helpers'

import '../../../../shared/work-items'
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

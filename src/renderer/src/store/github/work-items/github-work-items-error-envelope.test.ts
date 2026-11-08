import { answered } from '../requests/answered-request.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../github-slice-test-harness'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

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

  it('force-retry invalidates a still-failing in-flight request instead of deduping onto it', async () => {
    // Forced Retry must not join failing nonforced requests; require fresh fetch to clear banner on success (design §2 criterion 4).
    const store = createTestStore()
    let resolveFailing: (v: unknown) => void = () => {}
    const failingRequest = new Promise((resolve) => {
      resolveFailing = resolve
    })
    mockApi.gh.listWorkItems.mockReturnValueOnce(failingRequest).mockResolvedValueOnce({
      items: [],
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      }
    })

    const initialFetch = store.getState().fetchWorkItems('repo-id', '/repo', 24, '')
    const forcedFetch = store.getState().fetchWorkItems('repo-id', '/repo', 24, '', { force: true })

    // Let the initial request settle with an error so the force path runs.
    resolveFailing({
      items: [],
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })
    await initialFetch.catch(() => {})
    await forcedFetch

    const after = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(after.error).toBeNull()
  })

  it('flags githubUnavailable while serving stale cached rows after a failed refresh', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const item = {
      type: 'pr',
      number: 8,
      title: 'Cached PR',
      url: 'https://example.test/8',
      updatedAt: '2026-05-21T00:00:00Z'
    } as GitHubWorkItem
    mockApi.gh.listWorkItems
      .mockResolvedValueOnce({
        items: [item],
        sources: {
          issues: null,
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
      })
      .mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))
      .mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))

    try {
      const repos = [{ repoId: 'github-repo', path: '/server/github-repo' }]
      await store.getState().fetchWorkItemsAcrossRepos(repos, 24, 100, '')

      const result = answered(
        await store.getState().fetchWorkItemsAcrossRepos(repos, 24, 100, '', { force: true })
      )

      expect(result.items).toEqual([{ ...item, repoId: 'github-repo' }])
      expect(result.failedCount).toBe(0)
      expect(result.githubUnavailable).toBe(true)
      expect(result.requestFailureCount).toBe(1)

      const completeOnly = answered(
        await store.getState().fetchWorkItemsAcrossRepos(repos, 24, 100, '', {
          force: true,
          requireComplete: true,
          allowStaleFallback: false
        })
      )
      expect(completeOnly.items).toEqual([])
      expect(completeOnly.failedCount).toBe(1)
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('keeps the partial-failure count when another GitHub repo still loads', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const item = {
      type: 'pr',
      number: 8,
      title: 'Loaded PR',
      url: 'https://example.test/8',
      updatedAt: '2026-05-21T00:00:00Z'
    } as GitHubWorkItem
    mockApi.gh.listWorkItems
      .mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))
      .mockResolvedValueOnce({
        items: [item],
        sources: {
          issues: null,
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
      })

    try {
      const result = answered(
        await store.getState().fetchWorkItemsAcrossRepos(
          [
            { repoId: 'unavailable-repo', path: '/server/unavailable-repo' },
            { repoId: 'loaded-repo', path: '/server/loaded-repo' }
          ],
          24,
          100,
          ''
        )
      )

      expect(result.items).toEqual([{ ...item, repoId: 'loaded-repo' }])
      expect(result.failedCount).toBe(1)
      expect(result.githubUnavailable).toBe(false)
    } finally {
      consoleWarn.mockRestore()
    }
  })
})

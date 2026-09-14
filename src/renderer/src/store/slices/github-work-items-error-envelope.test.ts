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

  it('stores resolved sources on the cache entry for the indicator to read', async () => {
    // Why: parent design doc §1 suppression rule — the Tasks header indicator
    // consults `sources.issues` vs `sources.prs` on the cache entry. This is
    // the round-trip through fetchWorkItems that populates those fields.
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [],
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      }
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')

    const result = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(result.sources).toEqual({
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' },
      originCandidate: { owner: 'fork', repo: 'r' },
      upstreamCandidate: { owner: 'up', repo: 'r' }
    })
    expect(result.error).toBeNull()
  })

  it('stamps the issues-side ClassifiedError with its source slug for banner copy', async () => {
    // Why: parent design doc §2 partial-failure rule — when the issue fetch
    // returns a 403 but the PR fetch succeeds, the cache entry carries the
    // successful items AND the error for the failing side so the banner +
    // list render together. The error's `source` is pinned to the issues
    // slug so the banner copy stays correct even if the cache entry later
    // receives new data from another read.
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [],
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')

    const result = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(result.error).toMatchObject({
      type: 'permission_denied',
      message: 'no access',
      source: { owner: 'up', repo: 'r' }
    })
  })

  it('rejects provider-side partial results when completeness is required', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [],
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })

    await expect(
      store
        .getState()
        .fetchWorkItems('repo-id', '/repo', 24, '', { force: true, requireComplete: true })
    ).rejects.toThrow('partial result')
  })

  it('force-retry invalidates a still-failing in-flight request instead of deduping onto it', async () => {
    // Why: parent design doc §2 acceptance criterion 4 — the [Retry] button
    // must re-invoke the fetch with force=true and clear the banner on
    // success. That only works when force=true does not silently dedupe onto
    // a still-failing non-forcing request.
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

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
    const after = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(after.error).toBeNull()
  })

  it('threads noCache only when explicitly requested for work-item fetches', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems
      .mockResolvedValueOnce({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })
      .mockResolvedValueOnce({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })
      .mockResolvedValueOnce({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })

    await store.getState().fetchWorkItems('repo-normal', '/repo/normal', 24, '')
    await store.getState().fetchWorkItems('repo-force', '/repo/force', 24, '', { force: true })
    await store.getState().fetchWorkItems('repo-fresh', '/repo/fresh', 24, '', {
      force: true,
      noCache: true
    })

    expect(mockApi.gh.listWorkItems).toHaveBeenNthCalledWith(1, {
      repoPath: '/repo/normal',
      repoId: 'repo-normal',
      limit: 24,
      query: undefined
    })
    expect(mockApi.gh.listWorkItems).toHaveBeenNthCalledWith(2, {
      repoPath: '/repo/force',
      repoId: 'repo-force',
      limit: 24,
      query: undefined
    })
    expect(mockApi.gh.listWorkItems).toHaveBeenNthCalledWith(3, {
      repoPath: '/repo/fresh',
      repoId: 'repo-fresh',
      limit: 24,
      query: undefined,
      noCache: true
    })
  })

  it('does not dedupe a no-cache forced fetch onto a cacheable forced request', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: []
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    let resolveCacheable: (value: WorkItemsEnvelope) => void = () => {}
    const cacheableRequest = new Promise<WorkItemsEnvelope>((resolve) => {
      resolveCacheable = resolve
    })
    mockApi.gh.listWorkItems.mockReturnValueOnce(cacheableRequest).mockResolvedValueOnce({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })

    const landingProbe = store
      .getState()
      .fetchWorkItems('repo-id', '/repo', 24, '', { force: true })
    await Promise.resolve()
    const noCacheRefresh = store
      .getState()
      .fetchWorkItems('repo-id', '/repo', 24, '', { force: true, noCache: true })

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(1)
    resolveCacheable({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })
    await landingProbe
    await noCacheRefresh

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
    expect(mockApi.gh.listWorkItems).toHaveBeenNthCalledWith(2, {
      repoPath: '/repo',
      repoId: 'repo-id',
      limit: 24,
      query: undefined,
      noCache: true
    })
  })

  it('quietly skips SSH repos without a resolved GitHub remote in cross-repo fetches', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const item = {
      type: 'pr',
      number: 7,
      title: 'Server PR',
      url: 'https://example.test/7',
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
      const result = await store.getState().fetchWorkItemsAcrossRepos(
        [
          { repoId: 'ssh-repo', path: '/server/ssh-repo' },
          { repoId: 'github-repo', path: '/server/github-repo' }
        ],
        24,
        100,
        ''
      )

      expect(result.failedCount).toBe(0)
      expect(result.items).toEqual([{ ...item, repoId: 'github-repo' }])
      expect(consoleWarn).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('flags githubUnavailable when a GitHub repo fails with a 5xx outage and no cache', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApi.gh.listWorkItems.mockRejectedValue(new Error('HTTP 503: Service Unavailable'))

    try {
      const result = await store
        .getState()
        .fetchWorkItemsAcrossRepos(
          [{ repoId: 'github-repo', path: '/server/github-repo' }],
          24,
          100,
          ''
        )

      expect(result.items).toEqual([])
      expect(result.failedCount).toBe(1)
      expect(result.githubUnavailable).toBe(true)
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('flags a GitHub outage returned by a remote runtime method', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-outage',
      ok: false,
      error: { code: 'runtime_error', message: 'HTTP 503: Service Unavailable' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    try {
      const result = await store
        .getState()
        .fetchWorkItemsAcrossRepos(
          [{ repoId: 'caller-repo-id', path: '/server/repo' }],
          24,
          100,
          ''
        )

      expect(result.githubUnavailable).toBe(true)
      expect(result.failedCount).toBe(1)
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('does not attribute a remote runtime transport timeout to GitHub', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-runtime-timeout',
      ok: false,
      error: {
        code: 'runtime_unavailable',
        message: 'Runtime request timed out before github.listWorkItems completed'
      },
      _meta: { runtimeId: null }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    try {
      const result = await store
        .getState()
        .fetchWorkItemsAcrossRepos(
          [{ repoId: 'caller-repo-id', path: '/server/repo' }],
          24,
          100,
          ''
        )

      expect(result.githubUnavailable).toBe(false)
      expect(result.failedCount).toBe(1)
    } finally {
      consoleWarn.mockRestore()
    }
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

      const result = await store
        .getState()
        .fetchWorkItemsAcrossRepos(repos, 24, 100, '', { force: true })

      expect(result.items).toEqual([{ ...item, repoId: 'github-repo' }])
      expect(result.failedCount).toBe(0)
      expect(result.githubUnavailable).toBe(true)
      expect(result.requestFailureCount).toBe(1)

      const completeOnly = await store.getState().fetchWorkItemsAcrossRepos(repos, 24, 100, '', {
        force: true,
        requireComplete: true,
        allowStaleFallback: false
      })
      expect(completeOnly.items).toEqual([])
      expect(completeOnly.failedCount).toBe(1)
      expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(3)
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('ignores an ineligible SSH repo when every GitHub source is unavailable', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApi.gh.listWorkItems
      .mockRejectedValueOnce(new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE))
      .mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))

    try {
      const result = await store.getState().fetchWorkItemsAcrossRepos(
        [
          { repoId: 'ssh-repo', path: '/server/ssh-repo' },
          { repoId: 'github-repo', path: '/server/github-repo' }
        ],
        24,
        100,
        ''
      )

      expect(result.items).toEqual([])
      expect(result.failedCount).toBe(1)
      expect(result.githubUnavailable).toBe(true)
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
      const result = await store.getState().fetchWorkItemsAcrossRepos(
        [
          { repoId: 'unavailable-repo', path: '/server/unavailable-repo' },
          { repoId: 'loaded-repo', path: '/server/loaded-repo' }
        ],
        24,
        100,
        ''
      )

      expect(result.items).toEqual([{ ...item, repoId: 'loaded-repo' }])
      expect(result.failedCount).toBe(1)
      expect(result.githubUnavailable).toBe(false)
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('does not flag githubUnavailable for a 404 (not an outage)', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApi.gh.listWorkItems.mockRejectedValue(new Error('HTTP 404: Not Found'))

    try {
      const result = await store
        .getState()
        .fetchWorkItemsAcrossRepos(
          [{ repoId: 'github-repo', path: '/server/github-repo' }],
          24,
          100,
          ''
        )

      expect(result.failedCount).toBe(1)
      expect(result.githubUnavailable).toBe(false)
    } finally {
      consoleWarn.mockRestore()
    }
  })
})
